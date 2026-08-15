"""Modal entrypoint for the Modly FastAPI backend.

This is the Phase 0 wrapper: same `api/main.py`, three Volumes, CPU ASGI.
It does not start a GPU container and does not embed credentials.

Local (on your machine, never in chat / git):

    pip install -r modal/requirements.txt   # modal[api-proxy-support]
    modal token set
    modal serve modal/app.py
    modal deploy modal/app.py

The extra is required so the CLI can reach api.modal.com through a local
HTTP CONNECT / SOCKS proxy (HTTPS_PROXY, ALL_PROXY). It is *not* installed
into the Modal Image.

The public URL speaks the existing Modly HTTP contract
(`/health`, `/generate/*`, `/model/*`, `/optimize/*`, `/workspace/*`).
On Modal, jobs live in `modal.Dict` (`modly-jobs`) and generate() is
spawned on `GpuGenerator`.
"""

from __future__ import annotations

from pathlib import Path

import modal

APP_NAME = "modly-backend"
API_ROOT = Path("/root/api")
MODELS_DIR = Path("/modly/models")
WORKSPACE_DIR = Path("/modly/workspace")
EXTENSIONS_DIR = Path("/modly/extensions")

# Repo-relative: `modal serve modal/app.py` is launched from the repository root.
REPO_API = Path(__file__).resolve().parent.parent / "api"

models_vol = modal.Volume.from_name("modly-models", create_if_missing=True)
workspace_vol = modal.Volume.from_name("modly-workspace", create_if_missing=True)
extensions_vol = modal.Volume.from_name("modly-extensions", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "libgl1", "libglib2.0-0")
    .pip_install_from_requirements(str(REPO_API / "requirements.txt"))
    .env(
        {
            "MODELS_DIR": str(MODELS_DIR),
            "WORKSPACE_DIR": str(WORKSPACE_DIR),
            "EXTENSIONS_DIR": str(EXTENSIONS_DIR),
            "MODLY_RUNTIME": "modal",
            "MODLY_USE_GPU_WORKER": "1",
            "MODLY_APP_NAME": APP_NAME,
        }
    )
    .add_local_dir(str(REPO_API), remote_path=str(API_ROOT))
)

app = modal.App(APP_NAME, image=image)


def _load_fastapi():
    import sys

    sys.path.insert(0, str(API_ROOT))
    from main import app as fastapi_app  # type: ignore  # noqa: PLC0415

    return fastapi_app


OFFICIAL_REPOS = (
    "https://github.com/lightningpixel/modly-hunyuan3d-mini-extension",
    "https://github.com/lightningpixel/modly-triposg-extension",
    "https://github.com/lightningpixel/modly-trellis2-extension",
)


@app.function(
    volumes={
        str(MODELS_DIR): models_vol,
        str(WORKSPACE_DIR): workspace_vol,
        str(EXTENSIONS_DIR): extensions_vol,
    },
    timeout=60 * 60,
    scaledown_window=5 * 60,
)
@modal.concurrent(max_inputs=20)
@modal.asgi_app()
def fastapi_app():
    """CPU public URL. Do not attach a GPU here — status polling would pin it."""
    return _load_fastapi()


@app.function(
    gpu=["L40S", "L4", "A100"],
    volumes={
        str(MODELS_DIR): models_vol,
        str(WORKSPACE_DIR): workspace_vol,
        str(EXTENSIONS_DIR): extensions_vol,
    },
    timeout=60 * 60,
)
def setup_official_extensions():
    """Clone official model extensions onto the Volume and run setup.py on GPU."""
    import os
    import sys

    os.environ.setdefault("MODELS_DIR", str(MODELS_DIR))
    os.environ.setdefault("WORKSPACE_DIR", str(WORKSPACE_DIR))
    os.environ.setdefault("EXTENSIONS_DIR", str(EXTENSIONS_DIR))
    os.environ.setdefault("MODLY_RUNTIME", "modal")
    sys.path.insert(0, str(API_ROOT))

    from services.extension_install import (
        clear_incomplete,
        download_github_tarball,
        extract_extension,
        parse_github_repo,
    )
    from services.generator_registry import EXTENSIONS_DIR as ext_dir

    installed: list[str] = []
    for url in OFFICIAL_REPOS:
        owner, repo = parse_github_repo(url)
        tarball = download_github_tarball(owner, repo)
        ext_id = extract_extension(tarball, ext_dir, url)
        _run_setup_py(ext_dir / ext_id)
        clear_incomplete(ext_dir, ext_id)
        installed.append(ext_id)
    extensions_vol.commit()
    return {"installed": installed}


# ---------------------------------------------------------------------------
# Phase 3 placeholder: GPU worker. Not wired to FastAPI yet.
# When generation.py stops using an in-process `_jobs` dict, spawn this
# from the CPU ASGI instead of running BaseGenerator on the web container.
# ---------------------------------------------------------------------------

@app.cls(
    gpu=["L40S", "L4", "A100"],
    volumes={
        str(MODELS_DIR): models_vol,
        str(WORKSPACE_DIR): workspace_vol,
        str(EXTENSIONS_DIR): extensions_vol,
    },
    timeout=60 * 60,
    scaledown_window=10 * 60,
)
class GpuGenerator:
    @modal.enter()
    def start(self) -> None:
        import os
        import sys

        os.environ.setdefault("MODELS_DIR", str(MODELS_DIR))
        os.environ.setdefault("WORKSPACE_DIR", str(WORKSPACE_DIR))
        os.environ.setdefault("EXTENSIONS_DIR", str(EXTENSIONS_DIR))
        os.environ.setdefault("MODLY_RUNTIME", "modal")
        os.environ.setdefault("MODLY_APP_NAME", APP_NAME)
        sys.path.insert(0, str(API_ROOT))
        from services.generator_registry import generator_registry  # noqa: PLC0415

        generator_registry.initialize()
        self.registry = generator_registry

    @modal.method()
    def generate(self, job_id: str, model_id: str, image_bytes: bytes, params: dict, collection: str = "Default") -> str:
        """Run one image-to-mesh job and persist status in modal.Dict."""
        from services.generators.base import GenerationCancelled
        from services.job_store import get_job_store

        store = get_job_store()
        store.update(job_id, status="running", progress=0, step="Loading model")

        def progress_cb(pct: int, step: str = "") -> None:
            if store.is_cancelled(job_id):
                raise GenerationCancelled()
            current = store.get(job_id)
            if current is None:
                return
            patch: dict = {}
            if pct > current.progress:
                patch["progress"] = pct
            if step:
                patch["step"] = step
            if patch:
                store.update(job_id, **patch)

        try:
            self.registry.switch_model(model_id)
            gen = self.registry.get_active()
            coll_dir = WORKSPACE_DIR / collection
            coll_dir.mkdir(parents=True, exist_ok=True)
            gen.outputs_dir = coll_dir
            output_path = Path(gen.generate(image_bytes, params, progress_cb))
            try:
                rel = output_path.relative_to(WORKSPACE_DIR)
            except ValueError:
                rel = Path(collection) / output_path.name
            store.update(job_id, status="done", progress=100, output_url=f"/workspace/{rel.as_posix()}")
            workspace_vol.commit()
            models_vol.commit()
            return rel.as_posix()
        except GenerationCancelled:
            store.update(job_id, status="cancelled")
            raise
        except Exception as exc:  # noqa: BLE001
            store.update(job_id, status="error", error=str(exc))
            raise

    @modal.method()
    def setup_extension(self, ext_id: str) -> str:
        from services.extension_install import clear_incomplete
        from services.generator_registry import EXTENSIONS_DIR as ext_dir

        target = ext_dir / ext_id
        _run_setup_py(target)
        clear_incomplete(ext_dir, ext_id)
        extensions_vol.commit()
        return ext_id


def _run_setup_py(ext_dir: Path) -> None:
    import subprocess
    import sys

    setup_py = ext_dir / "setup.py"
    if not setup_py.exists():
        return
    gpu_sm = 0
    try:
        import torch

        if torch.cuda.is_available():
            major, minor = torch.cuda.get_device_capability(0)
            gpu_sm = major * 10 + minor
    except Exception:
        pass
    result = subprocess.run(
        [sys.executable, str(setup_py), sys.executable, str(ext_dir), str(gpu_sm)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr[-4000:] or result.stdout[-4000:] or "setup.py failed")
