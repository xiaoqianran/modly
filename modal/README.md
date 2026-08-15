# Modly on Modal

Phase 0 wrapper around the existing FastAPI app. Full plan:
[`docs/modal-remote-backend.md`](../docs/modal-remote-backend.md).

The Electron app never points the renderer at this URL directly. It keeps
`http://127.0.0.1:8765` and runs a local gateway (`electron/main/remote-gateway.ts`)
so upstream UI/API additions stay compatible.

## Deploy (on your machine only)

```bash
pip install -r modal/requirements.txt   # modal[api-proxy-support]
# equivalent: pip install 'modal[api-proxy-support]'
modal token set          # never paste the token into git or chat
modal serve modal/app.py # ephemeral URL, live-reloads
modal deploy modal/app.py
```

`api-proxy-support` is the default local install. Plain `modal` cannot talk
to `api.modal.com` through `HTTPS_PROXY` / `ALL_PROXY` (HTTP CONNECT or
SOCKS4/5). Opt out with `MODAL_DISABLE_API_PROXY=1` or
`disable_api_proxy = true` in `~/.modal.toml`.

This extra is **laptop-only**. Do not add it to the FastAPI Image.

Check:

```bash
curl https://<workspace>--modly-backend-fastapi-app.modal.run/health
```

Expected: `{"status":"ok"}`.

## What this image contains

- `api/` copied to `/root/api`
- `api/requirements.txt` (FastAPI, trimesh, huggingface_hub, …)
- Three Volumes: `modly-models`, `modly-workspace`, `modly-extensions`

After deploy, bake official model extensions (GPU, once):

```bash
modal run modal/app.py::setup_official_extensions
```

That clones Hunyuan Mini / TripoSG / TRELLIS.2 onto `modly-extensions`
and runs each `setup.py` on an L40S/L4/A100.

Optional public-URL auth: set `MODLY_API_TOKEN` on the Modal app, and the
same value in Modly settings / `MODLY_REMOTE_API_TOKEN`. `/health` stays open.

`POST /generate/from-image` spawns `GpuGenerator`; job status lives in
`modal.Dict` (`modly-jobs`) so polling is not stuck to one container.

## Secrets

Create these in the Modal dashboard, never in the repo:

- HuggingFace: `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN`
- Later: a random `MODLY_API_TOKEN` for Electron → Modal

If a token was ever pasted into a chat, rotate it before deploying.
