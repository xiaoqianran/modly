# MODAL-REMOTE-BACKEND

- Status: proposed
- Date: 2026-08-15

## Decision

Keep the Modly Electron / React desktop app on the user's machine, and move
the FastAPI + model-extension runtime to Modal. Local mode stays the default.
Remote mode is an explicit backend switch: no local Python process, no local
model weights, no local extension venvs.

This is **not** "change `apiUrl` and ship". CodeGraph (173 files, 2,305 nodes,
5,672 edges) plus a source pass show eight coupling surfaces. The four blocks
in the original sketch are necessary but not sufficient.

## Context

Today the desktop app owns both UI and compute:

```
Electron main
  python-bridge.ts  →  uvicorn main:app 127.0.0.1:8765
    MODELS_DIR / WORKSPACE_DIR / EXTENSIONS_DIR from settings-store
  ipc-handlers.ts   →  extensions install, model download, setup, FS
Renderer
  appStore.initApp() → window.electron.python.start()
  useApi()           → axios.create({ baseURL: apiUrl })
  ModelsPage         → window.electron.model.*  (local disk + hardcoded 127.0.0.1)
  extensionsStore    → window.electron.extensions.* (local folders + setup.py)
```

`useApi.ts` is already backend-addressable. Almost everything else that
touches models, extensions, or workspace files still goes through Electron IPC
and assumes the FastAPI process shares the same filesystem.

## What stays local

- Generate page, model-parameter UI, Workflow canvas, 3D / splat viewers
- Axios generate / poll / cancel / optimize (once `apiUrl` is remote)
- Workflow JSON, For-Each folder walks, Image / Load-3D-Mesh file pickers
- Built-in **process** nodes (`mesh-optimizer`, `mesh-exporter`, smoother,
  remesher, repair) — these run in Electron workers / local Python, not in
  `GeneratorRegistry`
- Ollama agent chat (it hardcodes `http://localhost:8765` and talks to a
  local Ollama)

## What moves to Modal

- FastAPI (`api/main.py` and routers)
- Model-extension registry + isolated venvs (`ExtensionProcess` / `runner.py`)
- HuggingFace weight downloads
- Generated GLB / splat workspace
- GPU inference (TRELLIS.2, Hunyuan, …)

## Target topology

```
Laptop                              Modal
┌─────────────────────┐            ┌──────────────────────────────────┐
│ Electron + React    │   HTTPS    │ CPU ASGI  (always the public URL)│
│ file pickers        │ ─────────► │  FastAPI, auth, job Dict         │
│ process nodes (CPU) │            │  /health /generate /optimize     │
│ 3D viewer           │ ◄───────── │         │                        │
│ workflows JSON      │    GLB     │         ▼                        │
└─────────────────────┘            │ GPU Cls  L4 / L40S / A100        │
                                   │  TRELLIS / Hunyuan venvs         │
                                   │  Volumes: models, workspace, exts│
                                   └──────────────────────────────────┘
```

Do **not** put the ASGI app on a GPU container. Polling `/generate/status`
every second would pin an L40S. CPU web + GPU worker is the cost model that
matches this codebase's job loop.

## Eight change surfaces

### 1. Backend mode (`appStore` + `App.tsx` + first-run)

`initApp` always calls `window.electron.python.start()`. `App.tsx` then
blocks the whole UI on `setupStatus === 'done'` (local Python venv) and
`backendStatus === 'ready'`.

Remote mode must:

- persist `backendMode: 'local' | 'remote'` and `remoteApiUrl`
- skip `python.start()`, skip first-run Python install
- `GET {remoteApiUrl}/health` and set `apiUrl`
- still allow local file pickers (images / meshes stay on disk until upload)

### 2. Electron main still hardcodes `127.0.0.1:8765`

Changing `appStore.apiUrl` is not enough. These main-process calls never
read the renderer store:

| Call site | Why it breaks in remote mode |
|-----------|------------------------------|
| `app:info` / `python:status` | always return `API_BASE_URL` |
| `model-downloader.ts` | `PYTHON_API_URL` default `http://127.0.0.1:8765` |
| `model:isDownloaded` / `listDownloaded` / `delete` | scan **local** `modelsDir` |
| `model:pauseDownload` / `cancelDownload` / `unloadAll` | axios to local FastAPI |
| `model:export` | axios to local `/export` |
| `extensions:install` / `reload` / `repair` | write local folders, then POST local `/extensions/reload` |
| `settings:set` HF token | POST local `/settings/hf-token` |
| `api:updatePaths` | POST local `/settings/paths` |

Remote mode needs a single `getApiBaseUrl()` in main (from `settings.json`)
and every `API_BASE_URL` / `PYTHON_API_URL` use must go through it.

### 3. Extension install is Electron-owned, not FastAPI-owned

`/extensions/setup/{id}` exists, but the real installer is
`ipc-handlers.ts` (`extensions:installFromGitHub`): download tarball →
extract → validate → atomic swap → run `setup.py` with local GPU SM →
POST `/extensions/reload`.

`extensionsStore` and `ModelsPage` never talk to FastAPI for catalog.

Remote policy:

- **Official model extensions**: bake into the Modal Image (or a committed
  Volume snapshot). No runtime `setup.py` on a laptop.
- **User-installed model extensions**: optional later; clone + setup on a
  Modal CPU function writing the extensions Volume. Do not do this in v1.
- **Process extensions**: stay local. They are CPU mesh tools and need
  local paths.

Add `GET /extensions/catalog` on FastAPI so remote UI can list what the
cloud registry actually loaded, instead of lying with a local folder scan.

### 4. Model weights: Volume, not `~/.modly/models`

`ModelsPage.refreshInstalledIds` calls `window.electron.model.isDownloaded`,
which stats the local models directory. `downloadModelFromHF` streams SSE
from local FastAPI into that same directory.

Remote:

- download target = Modal Volume `/modly/models/{model_id}`
- "installed?" = `GET /model/all` (`generator_registry.all_status()`)
- download button = SSE against the **remote** `/model/hf-download`
- delete / pause / cancel = remote endpoints, not `rm` on the laptop

HF token stays in Electron settings and is sent as the existing query
param, or stored as a Modal Secret. Never commit tokens.

### 5. Path split: local FS vs remote workspace

Three different path languages already exist:

| Kind | Example | Who can read it |
|------|---------|-----------------|
| Local absolute | `C:\Users\…\cat.png` | Electron `fs:*` only |
| Workspace-relative | `Default/mesh.glb` | FastAPI `WORKSPACE_DIR` |
| HTTP artifact | `/workspace/Default/mesh.glb` | Viewer via `apiUrl + url` |

`import-by-path` (`optimize.py:397`) opens `Path(body.path)` **on the
server**. A laptop path sent to Modal 404s. `serve-file` then serves that
absolute path — fine on localhost, a path-traversal risk on a public URL.

`workflowRunStore` after a model node does
`nodeInputPath = workspaceDir + rel`. The next **process** node feeds that
local path into `extensions.runProcess`. If the GLB only exists on Modal,
local process nodes have nothing to open.

v1 rule:

- **Into Modal**: always upload bytes (`multipart`), never a host path
- **Out of Modal**: always `/workspace/...` HTTP URLs for the viewer
- **Process nodes**: download the GLB to a local temp (or keep a small
  local workspace cache) before `runProcess`
- Replace `import-by-path` with `import` (upload) when `backendMode === 'remote'`
- Lock `serve-file` to `WORKSPACE_DIR` (needed even for local, required for remote)

### 6. In-memory jobs will lose polls across containers

`api/routers/generation.py` stores `_jobs` in a process dict. Modal may
route `POST /generate/from-image` and `GET /generate/status/{id}` to
different containers.

v1: `modal.Dict` (or a JSON file on the workspace Volume) for job records.
The GPU worker updates the Dict; the CPU ASGI only reads it.

### 7. Auth — the current API is bind-to-localhost

CORS is `allow_origins=["*"]`. There is no bearer check. That is safe only
because uvicorn binds `127.0.0.1`. A Modal `.modal.run` URL is public.

Require `Authorization: Bearer <token>` (Modal Secret) on every route
except `/health`. Electron / axios attach it in remote mode. Also enable
`requires_proxy_auth=True` on the ASGI decorator if the workspace should
stay private to the Modal account.

`/optimize/serve-file?path=` must not accept arbitrary absolute paths.

### 8. Agent and asset library stay out of v1 remote

- `api/routers/agent.py` hardcodes `MODLY_API = "http://localhost:8765"`
- Asset library IPC only allows `Workflows/` and `Exports/` under the
  **local** workspace

Leave both on local backend. Remote mode hides or no-ops them.

## Modal layout

Three Volumes:

| Volume | Mount | Role |
|--------|-------|------|
| `modly-models` | `/modly/models` | HF weights (write-once, read-many) |
| `modly-workspace` | `/modly/workspace` | generated GLB / splat |
| `modly-extensions` | `/modly/extensions` | official model extension checkouts + venvs |

Two functions:

1. **CPU ASGI** — existing FastAPI, `modal.Dict` job store, Volume mounts,
   no GPU, `scaledown_window` ~5 min.
2. **GPU Cls** — `gpu=["L40S", "L4", "A100"]` fallback, `@modal.enter`
   loads the active generator from the models Volume, `@modal.method`
   runs `generate()`. Start with `min_containers=0`. Add `min_containers=1`
   only if cold-start (venv + weight load) is unacceptable.

Bake official extensions into the Image (or a one-shot `setup` function
that writes the extensions Volume) instead of running `setup.py` from the
laptop. Extension `setup.py` already keys off GPU SM; on Modal, detect SM
inside the GPU container (`torch.cuda.get_device_capability`).

`api/requirements.txt` is the **host** API (fastapi, trimesh, huggingface_hub).
Torch / CUDA live in each extension venv, same as today. Do not pip-install
torch into the ASGI image.

## Implementation order

1. **Modal skeleton** — wrap `api/main.py` with `@modal.asgi_app`, Volumes,
   health check. No frontend change.
2. **Remote mode plumbing** — `backendMode` + `remoteApiUrl` in settings
   and `appStore`; skip local Python; health-check the Modal URL.
3. **Point Electron IPC at the same URL** — `getApiBaseUrl()`; remote
   download / status / unload / export.
4. **Catalog + prebaked official extensions** — `GET /extensions/catalog`;
   Models page uses it in remote mode.
5. **Upload import + workspace cache** — so Generate import and workflow
   process nodes keep working.
6. **Job Dict + GPU worker split + bearer auth**.

Do not start at (6). A CPU-only Modal deploy that returns `/health` is the
first proof the Electron app can run without `python.start()`.

## Risks

- Cold start of a Hunyuan / TRELLIS venv on L40S can be minutes. Prebake
  venvs on the Volume; use `@modal.enter` so weights load once per
  container, not once per request.
- Volume writes need `volume.commit()` after downloads, or the next
  container will not see the weights.
- `pymeshlab` / native optimize deps must be in the CPU image, not only
  in extension venvs.
- Leaked Modal tokens must be rotated. Tokens never go in git, settings
  committed to the repo, or `environment.json`.
