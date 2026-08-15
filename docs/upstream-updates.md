# What upstream actually changes (and why we do not patch each one)

Re-indexed **2026-08-15** with CodeGraph 1.5.0. Two trees, same tool:

| Tree | Ref | Files | Nodes | Edges | `modal/` |
|------|-----|------:|------:|------:|----------|
| **This overlay** | `cursor/modal-user-prefs-d55c` | **217** | **2,955** | **7,583** | yes |
| **Upstream, no Modal** | `lightningpixel/modly` `dev` @ `5aed279` (2026-08-13) | **179** | **2,496** | **6,318** | **none** |
| Upstream `main` | still `b771e29` (2026-07-25) — our fork point | — | — | — | none |

`src/` files on disk: **112 vs 111**. **100 are byte-identical**, including the whole generate stack (`useApi` / `useGeneration` / `appStore` / `GeneratePage` / HUD / Panel / Options / Viewer3D / ImageUpload / Models / Workflows). The 3 extra files here are new overlay-only (`modalPrefs.ts`, `modalPrefs.test.ts`, `appSettings.ts`). Differing shared `src/` files are Settings overlay, FirstRun remote, or **their** extension-install work (`extensionsStore` / `ExtensionDrawer`) which we did not fork.

CodeGraph `query modal`:

- Upstream: **1 hit** — `HelpModal` in `WorkflowsPage.tsx` (a UI dialog, not Modal.com). **No `gpuLinger` / `modalPrefs`.**
- Overlay: hits live in `modal/app.py`, `api/services/modal_*`, `job_store.ModalJobStore`, Settings `ApplicationSection`, and `electron/main/remote-ipc.ts` (`afterSettingsSet`). **No Generate / `useApi` / Models / Viewer / `ipc-handlers.ts` symbol.**

GPU linger / card prefs (2026-08-15, same index):

- `callers useApi` is still the **same 6 edges** as upstream. `impact useApi` is still the **same 15 Generate symbols**. `ApplicationSection` is not in that graph.
- `callers ApplicationSection` → only `SettingsPage`.
- `callers modalPrefsBody` → `remote-ipc.afterSettingsSet` + unit test. Not `ipc-handlers.ts`.
- `callers set_modal_prefs` → `POST /settings/modal` + tests.
- `electron/main/ipc-handlers.ts` **byte-identical** to our `main` (0-byte diff). Official `settings:set` can merge without replaying a Modal POST.
- File intersection vs upstream `dev` since the fork: `electron-api.ts` + `electron.d.ts` only. Their hunk is `needsRepair?` on install; ours is the settings type alias. **Different regions — git should auto-merge.**

---

## Are we decoupled from the original repo?

**The product UI is decoupled. The merge is “almost never edit,” not “literally never.”**

CodeGraph `callers useApi` is **the same 6 edges** on both trees:

`GeneratePage` → `useApi`  
`GenerationOptions` → `useApi`  
`useGeneration` → `useApi`

`impact useApi` stays inside Generate HUD / Panel / ImageUpload / Viewer3D. None of those files import overlay code. They still do `axios.create({ baseURL: apiUrl })` with `apiUrl = http://127.0.0.1:8765`.

`callers setupIpcHandlers` is still only `electron/main/index.ts` on both trees. We inserted **one extra call** in that file: `installIpcIntercept()` immediately before `setupIpcHandlers`. That wrap is the chokepoint. `ipc-handlers.ts` itself has **no** `remote` / `modal` branches and **no** linger POST — `settings:set` is `wrap-settings-set` in `ipc-policy.ts`, and the Modal write lives in `remote-ipc.afterSettingsSet`.

`callers spawn_gpu_generation` (overlay only): `generation.py` + `workflow_runs.py`. Local FastAPI still runs the in-process path when `MODLY_RUNTIME` is unset.

```
upstream renderer (unchanged)
    useApi / appStore.initApp / window.electron.*
            │
            ▼
      127.0.0.1:8765
            │
     local: uvicorn          remote: overlay gateway + ipc-intercept
            │                         │
            ▼                         ▼
     api/main.py                 same api/main.py on Modal CPU
                                      └ spawn GpuGenerator
```

---

## What they ship vs what we do

`lightningpixel/modly` `main` has not moved since our fork. `dev` has three merges after `b771e29`:

| Upstream `dev` change | Lands in | Overlay action on merge |
|---|---|---|
| CLI JSON errors (#257) | `tools/modly-cli/*` | **None** — we did not touch it |
| Extension registration validation (#233) | `ipc-handlers.ts`, `extensionsStore`, `ExtensionDrawer`, `generator_registry.py`, new `extension-install-recovery.ts` | **Take theirs.** We did not fork those files (except a 13-line type tweak in `ipc-handlers.ts`) |
| npm lifecycle scripts on install (#231) | `extension-install-utils.ts`, `build-builtins.mjs` | **None** — we did not touch it |
| Desktop UX / workflow browser (already in `main`) | `src/` | **None** |
| New `fs:*` IPC | prefix `fs:` | **None** — policy `local` |
| New FastAPI route | `api/routers/*` | **None** — 8765 default-proxies |
| New `model:*` / `extensions:*` IPC | `ipc-handlers.ts` | **None** — `forward-unknown` → `POST /desktop/ipc` |

So “almost never edit on merge” matches how they actually ship:

1. They add **UI and local IPC**, not a second HTTP client.
2. They keep `useApi({ baseURL: apiUrl })` and `apiUrl = 127.0.0.1:8765`.
3. They keep putting disk scans in `ipcMain.handle('model:…')`.

Do not put Modal `if`s back into `ipc-handlers.ts`. That file is where their 633-line `dev` rewrite lives.

---

## Files that would actually conflict if you merge today’s `dev`

Intersection of “we touched since `b771e29`” ∩ “they touched on `dev`” is **five files**:

| File | Our hunk | Their hunk | Replay cost |
|---|---|---|---|
| `electron/main/index.ts` | +2 lines (`installIpcIntercept`) | +~10 lines (extension-install recovery before Python starts) | **30 seconds** — keep both, order: recover → intercept → `setupIpcHandlers` |
| `electron/main/ipc-handlers.ts` | +13 / −4 (async wrappers + `backendMode` on `settings:set`) | **+481 / −152** (install validation) | Re-apply the settings type + `async` on two handlers after taking theirs |
| `electron/preload/electron-api.ts` | settings types for remote | +2 (`needsRepair?`) | Merge both fields |
| `src/shared/types/electron.d.ts` | same settings types | +1 (`needsRepair?`) | Merge both fields |
| `api/routers/extensions.py` | +79 (catalog / install-from-github) | +8 / −3 (registration validation) | Keep both; different functions |

Everything else we added is **new files** (`modal/`, `remote-*.ts`, `ipc-policy.ts`, `modal_*.py`) — git will not conflict.

Renderer files we promised not to fork are still identical to `dev`:

`useApi.ts` · `useGeneration.ts` · `appStore.ts` · `GeneratePage.tsx` · `GenerationPanel.tsx` · `GenerationHUD.tsx` · `Viewer3D.tsx` · `ModelsPage.tsx` · `WorkflowsPage.tsx`

`extensionsStore.ts` / `ExtensionDrawer.tsx` diverged because **they** changed them and **we did not**. Merge = take upstream.

---

## When you *would* have to edit overlay code

Not “they released a new Generate button.” Only if they break one of the three contracts:

1. **Renderer stops using `127.0.0.1:8765` / `useApi`.** Unlikely; every caller in both graphs goes through that hook.
2. **A new host-absolute path POST** (another `import-by-path`). Add one classifier in `remote-gateway-logic.ts`.
3. **A new disk-scan IPC that must stay on the laptop** but uses a `model:` / `extensions:` name we currently `replace` or `forward-unknown`. Add one line to `ipc-policy.ts`.

Idle / cost changes stay in `remote-gateway.ts` and `modal/app.py`. Per-run chain + USD ledger is overlay-only (`api/services/run_*.py`, `GET /runs`). See [`docs/modal-cost.md`](modal-cost.md) and [`docs/modal-run-ledger.md`](modal-run-ledger.md).

---

## Bottom line

| Question | Answer |
|---|---|
| Is the feature set forked from the original UI? | **No.** Generate / poll / Models / Workflows are the upstream files. |
| If they update `main` the way they have been updating `dev`? | **You almost never modify overlay code.** You merge, maybe replay 2 lines in `index.ts` and a settings type in `ipc-handlers.ts`. |
| Can you promise zero conflicts forever? | **No.** `ipc-handlers.ts` is still a shared file (13 of our lines vs 633 of theirs). The intercept exists so those 13 stay small. |
