# Upstream compatibility (Modal overlay)

**Overlay** = a layer in front of an unchanged app. The renderer still
thinks FastAPI lives at `http://127.0.0.1:8765`. Remote mode only swaps
*who listens on that port* (uvicorn → local gateway). Modal wraps the
same `api/main.py`; it does not fork Generate / `useApi` / Models.

Two different “proxies” — do not mix them:

| Proxy | Where | Job |
|---|---|---|
| `modal[api-proxy-support]` | Laptop CLI | `modal serve/deploy` → `api.modal.com` via `HTTPS_PROXY` / `ALL_PROXY` |
| Electron overlay gateway | Laptop port 8765 | Modly UI → Modal FastAPI `https://….modal.run` |

```mermaid
flowchart TB
  subgraph frozen["Do not rewrite — upstream merge stays free"]
    UI["Generate / Viewer / Workflow / Models"]
    API["useApi + appStore.initApp"]
    IPCUI["window.electron.model / extensions"]
  end

  UI --> API
  UI --> IPCUI
  API -->|"always http://127.0.0.1:8765"| PORT["Port 8765"]
  IPCUI --> SHIM["ipc-intercept wraps ipcMain.handle"]
  SHIM -->|"same 8765"| PORT

  PORT -->|"local mode"| UV["uvicorn api/main.py on this machine"]
  PORT -->|"remote mode"| GW["overlay: remote-gateway.ts"]

  GW -->|"default: transparent proxy"| MODAL["Modal CPU ASGI = same api/main.py"]
  GW -->|"import-by-path → multipart upload"| MODAL
  GW -->|"prefetch /workspace GLB to laptop cache"| CACHE["local workspaceDir"]
  CACHE --> PROC["process nodes stay local"]
```

```mermaid
flowchart LR
  subgraph laptop["Laptop"]
    CLI["modal CLI\nmodal[api-proxy-support]"]
    GW2["8765 overlay gateway"]
    PROC2["smooth / remesh / export"]
  end

  subgraph control["Modal control plane"]
    MAPI["api.modal.com"]
  end

  subgraph cloud["Modal app: modal/app.py"]
    ASGI["CPU ASGI FastAPI"]
    GPU["GPU Cls — Phase 3"]
    V1["Volume modly-models"]
    V2["Volume modly-workspace"]
    V3["Volume modly-extensions"]
  end

  CLI -->|"HTTPS_PROXY / ALL_PROXY"| MAPI
  MAPI -->|"serve / deploy"| ASGI
  GW2 -->|"HTTPS FastAPI URL"| ASGI
  ASGI --> V1
  ASGI --> V2
  ASGI --> V3
  ASGI -.-> GPU
  GPU --> V1
  GPU --> V2
  GPU --> V3
  GW2 -->|"cache GLB"| PROC2
```

Modly’s renderer (`src/`) and most Electron IPC stay pointed at `http://127.0.0.1:8765`.

When `backendMode` is `remote` (or `MODLY_REMOTE_API_URL` is set), Electron starts a **localhost gateway** on that same port instead of uvicorn. The gateway:

1. **Proxies** almost every HTTP request to the Modal FastAPI URL (new upstream routes work with no renderer change).
2. **Translates** the few host-path operations (`/optimize/import-by-path`, `/workspace/...` prefetch for process nodes).
3. **Intercepts IPC at `ipcMain.handle`** (`electron/main/ipc-intercept.ts`).
   Classification is by prefix (`electron/main/ipc-policy.ts`), not by
   editing `ipc-handlers.ts`. Upstream can change that 1600-line file
   without a Modal conflict.

## What you do **not** change when lightningpixel/modly adds a feature

| Upstream change | Overlay action |
|---|---|
| New FastAPI route used by `useApi()` | None — gateway proxies it |
| New Generate / Viewer / Workflow UI | None — still talks to 8765 |
| New job type that writes `/workspace/...` | None if the UI reads via HTTP; process nodes get prefetch |
| New `model:*` / `extensions:*` IPC | None — prefix forwards to `POST /desktop/ipc` |
| New host-absolute path POST | Add one translator in `remote-gateway.ts` |

Do **not** rewrite `appStore`, `useApi`, Generate, Viewer, or Workflow to know about Modal.

This is how a merge from `lightningpixel/modly` stays cheap: HTTP features
are free; only new “scan this laptop folder” IPC or host-absolute path POSTs
need a one-place overlay edit.

## Settings

- `backendMode`: `local` (default) or `remote`
- `remoteApiUrl`: Modal FastAPI URL (`https://….modal.run`)
- `remoteApiToken`: optional Bearer token (also `MODLY_REMOTE_API_TOKEN`)

Environment override (no settings UI needed):

```bash
export MODLY_REMOTE_API_URL=https://your-app.modal.run
export MODLY_REMOTE_API_TOKEN=...   # optional
```

Restart the app after changing backend mode.

## Cheap contract tests (no GPU, no `modal deploy`)

Live Modal smoke (unknown model 400, `/health` must not wake CPU, cancel must
stop the FunctionCall, catalog skips `.modly-incomplete`, spawn failure must
not CPU-fallback) is locked in as unit tests. They do **not** sit inside
`GpuGenerator.generate` or `useApi`.

| Suite | What it freezes |
|---|---|
| `electron/main/overlay-windows-contract.test.ts` | Every `window.electron.invoke` + every `useApi` HTTP path: local vs 8765 vs Modal |
| `electron/main/ipc-dispatch.test.ts` | Intercept switch without loading Electron |
| `electron/main/remote-gateway.test.ts` | Fake upstream: generate/status/cancel/runs JSON; `/runs` not cached; `/health` local |
| `api/tests/test_generate_dispatch.py` | Modal spawn never falls back to `_run_generation`; FunctionCall id recorded |
| `api/tests/test_overlay_windows_contract.py` | `/runs` snapshot keys (`chain`, `bill`, `leak`); catalog envelope skips incomplete |

```bash
npm test          # python unittest + node:test
npm run test:py
npm run test:node
```

Do **not** add `if TEST:` branches in `modal/app.py`. If a new Windows
operation should reach Modal, add a row to the overlay contract test.

## Local-only features (never send to Modal)

- Agent (Ollama + local filesystem)
- Asset Library (local `~/Modly`)
- Process nodes (smooth / remesh / optimize / export) — they run on the Mac after the gateway caches the GLB
