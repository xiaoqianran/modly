# What upstream actually changes (and why we do not patch each one)

CodeGraph index of this tree: **182 files / 2,410 nodes / 5,926 edges**.

`lightningpixel/modly` `main` is still at `b771e29` (2026-07-25). Recent
upstream work, newest first:

| Kind | Examples | Lands in | Overlay action |
|---|---|---|---|
| Desktop UX | workflow browser, tabs, font size, macOS build | `src/`, Electron chrome | **None** — never talks to Modal |
| New local FS IPC | `fs:listFiles`, `fs:selectTextFile` (For-Each, file-select params) | `ipc-handlers.ts` prefix `fs:` | **None** — policy `local` |
| Extension install hardening | staging dirs, `.modly-incomplete`, pip cache | `ipc-handlers.ts` | **None** — remote mode never runs that handler (`replace`) |
| Process vs model split | skip process extensions in Python registry | `generator_registry.py` | **None** — already the contract |
| New FastAPI route | rare | `api/routers/*` | **None** — 8765 gateway default-proxies |
| New `model:*` / `extensions:*` IPC | the next disk-scan helper | `ipc-handlers.ts` | `forward-unknown` → `POST /desktop/ipc` |

So “almost never edit on merge” is not a hope. It matches how they ship:

1. They add **UI and local IPC**, not a second HTTP client.
2. They keep `useApi({ baseURL: apiUrl })` and `apiUrl = 127.0.0.1:8765`.
3. They keep putting disk scans in `ipcMain.handle('model:…')`.

Our intercept plane is those three facts. Do not put Modal branches back
into `ipc-handlers.ts` — that file is where upstream conflicts live.
