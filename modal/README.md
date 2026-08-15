# Modly on Modal

Phase 0 wrapper around the existing FastAPI app. Full plan:
[`docs/modal-remote-backend.md`](../docs/modal-remote-backend.md).
**Cost model (deploy ≠ always-on):** [`docs/modal-cost.md`](../docs/modal-cost.md).

The Electron app never points the renderer at this URL directly. It keeps
`http://127.0.0.1:8765` and runs a local gateway (`electron/main/remote-gateway.ts`)
so upstream UI/API additions stay compatible. The gateway answers `/health`
locally, so opening the desktop does not wake Modal.

## Deploy (on your machine only)

`modal deploy` **registers** the app. Containers stay at zero until a
generate / download / setup request. Do not leave `modal serve` running.

```bash
pip install -r modal/requirements.txt   # modal[api-proxy-support]
# equivalent: pip install 'modal[api-proxy-support]'
modal token set          # never paste the token into git or chat
# Desktop can instead use Connect this session (memory only; not settings.json)
modal deploy modal/app.py
modal run modal/app.py::bake_official_extensions   # CPU clone + CPU HF + GPU setup.py
```

On Windows, double-click `scripts/deploy-modal.bat` instead: uv creates
`.venv-modal`, installs the CLI extra, opens Modal login, then deploys.
The Electron app does not spawn `modal` (that was `spawn EINVAL` on Windows).

`api-proxy-support` is the default local install. Plain `modal` cannot talk
to `api.modal.com` through `HTTPS_PROXY` / `ALL_PROXY` (HTTP CONNECT or
SOCKS4/5). Opt out with `MODAL_DISABLE_API_PROXY=1` or
`disable_api_proxy = true` in `~/.modal.toml`.

This extra is **laptop-only**. Do not add it to the FastAPI Image.

Only while editing `modal/app.py`:

```bash
modal serve modal/app.py   # ephemeral URL; no persistent snapshot; Ctrl-C when done
```

The public `/health` on `.modal.run` still works for a one-shot curl. The
desktop does **not** use it for readiness.

## Idle defaults

| | default | override |
|--|---------|----------|
| GPU | L40S only | `MODLY_GPU=A100` (never a silent A100 fallback) |
| GPU scaledown | 60s after success (2s after cancel), min=0 | Settings or `MODLY_GPU_SCALEDOWN` |
| CPU ASGI scaledown | 8s, min=0, buffer=0 | `MODLY_CPU_SCALEDOWN` |
| Memory snapshot | on (after deploy) | `MODLY_MEMORY_SNAPSHOT=0` |
| GPU snapshot | off | `MODLY_GPU_SNAPSHOT=1` |

## What this image contains

- `api/` copied to `/root/api`
- `api/requirements.txt` (FastAPI, trimesh, huggingface_hub, …)
- Three Volumes: `modly-models`, `modly-workspace`, `modly-extensions`

Bake official model extensions without parking GitHub/HF on the GPU:

```bash
modal run modal/app.py::hydrate_official_extensions   # CPU clone
modal run modal/app.py::hydrate_official_models       # CPU snapshot_download
modal run modal/app.py::setup_official_extensions     # GPU setup.py only
# or all three:
modal run modal/app.py::bake_official_extensions
```

That clones Hunyuan Mini / TripoSG / TRELLIS.2 onto `modly-extensions`
and runs each `setup.py` on L40S.

Optional public-URL auth: set `MODLY_API_TOKEN` on the Modal app, and the
same value in Modly settings / `MODLY_REMOTE_API_TOKEN`. `/health` stays open
on Modal; the desktop gateway synthesizes its own `/health` and never waits
on a warm container.

`POST /generate/from-image` spawns `GpuGenerator`; job status lives in
`modal.Dict` (`modly-jobs`) so polling is not stuck to one container and
never pins the GPU.

## Secrets

Create these in the Modal dashboard, never in the repo:

- HuggingFace: `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN`
- Later: a random `MODLY_API_TOKEN` for Electron → Modal

If a token was ever pasted into a chat, rotate it before deploying.
