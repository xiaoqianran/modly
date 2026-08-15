# Modly on Modal

Phase 0 wrapper around the existing FastAPI app. Full plan:
[`docs/modal-remote-backend.md`](../docs/modal-remote-backend.md).

The Electron app never points the renderer at this URL directly. It keeps
`http://127.0.0.1:8765` and runs a local gateway (`electron/main/remote-gateway.ts`)
so upstream UI/API additions stay compatible.

## Deploy (on your machine only)

```bash
pip install modal
modal token set          # never paste the token into git or chat
modal serve modal/app.py # ephemeral URL, live-reloads
modal deploy modal/app.py
```

Check:

```bash
curl https://<workspace>--modly-backend-fastapi-app.modal.run/health
```

Expected: `{"status":"ok"}`.

## What this image contains

- `api/` copied to `/root/api`
- `api/requirements.txt` (FastAPI, trimesh, huggingface_hub, …)
- Three Volumes: `modly-models`, `modly-workspace`, `modly-extensions`

It does **not** yet contain:

- Official Hunyuan / TRELLIS extension venvs (Phase 2)
- GPU-backed `/generate` (Phase 3; `GpuGenerator` is a placeholder)
- Bearer auth (Phase 5)

## Secrets

Create these in the Modal dashboard, never in the repo:

- HuggingFace: `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN`
- Later: a random `MODLY_API_TOKEN` for Electron → Modal

If a token was ever pasted into a chat, rotate it before deploying.
