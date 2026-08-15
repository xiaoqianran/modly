"""Modal entrypoint for the Modly FastAPI backend.

Deploy registers the app. Containers are min=0 and scale to zero a few
seconds after the last request. Do **not** leave `modal serve` running:
that pins CPU (and would pin GPU if the web app lived there).

    pip install -r modal/requirements.txt   # modal[api-proxy-support]
    modal token set
    modal deploy modal/app.py
    modal run modal/app.py::bake_official_extensions

Smoke with `modal deploy`, not `modal serve`. Serve has no persistent
memory snapshot and keeps a container until you Ctrl-C.

The extra is required so the CLI can reach api.modal.com through a local
HTTP CONNECT / SOCKS proxy (HTTPS_PROXY, ALL_PROXY). It is *not* installed
into the Modal Image.

The public URL speaks the existing Modly HTTP contract. On Modal, jobs live
in `modal.Dict` (`modly-jobs`) and generate() is spawned on `GpuGenerator`.
The desktop answers `/health` locally so opening the app does not wake this
ASGI container.
"""

from __future__ import annotations

import sys
from pathlib import Path

import modal

APP_NAME = "modly-backend"
# Linux container paths. Keep these as str literals that start with "/".
# On Windows, str(pathlib.Path("/root/api")) is "\root\api", and Modal's
# Image.add_local_dir checks remote_path.startswith("/") — official docs:
# https://modal.com/docs/reference/modal.Image
#   .add_local_dir("./src", "/app/src")
#   .add_local_dir(..., remote_path="/assets")
#   .add_local_dir("/user/erikbern/.aws", remote_path="/root/.aws")
API_ROOT = "/root/api"
MODELS_DIR = "/modly/models"
WORKSPACE_DIR = "/modly/workspace"
EXTENSIONS_DIR = "/modly/extensions"

# Repo-relative: `modal serve modal/app.py` is launched from the repository root.
# Inside the container Modal copies this file to /root/app.py, so parent.parent/api
# would be /api — the FastAPI tree is mounted at API_ROOT instead.
REPO_API = Path(__file__).resolve().parent.parent / "api"


def _api_on_path() -> None:
    for candidate in (Path(API_ROOT), REPO_API):
        if candidate.is_dir():
            sys.path.insert(0, str(candidate))
            return
    sys.path.insert(0, str(REPO_API))


_api_on_path()
from services.modal_idle import ModalIdleSettings  # noqa: E402

IDLE = ModalIdleSettings.from_env()

# Secret.from_name has no create_if_missing (unlike Volume/Dict). A missing
# named secret must not block first deploy of the empty shell.
import importlib.util  # noqa: E402

def _load_workspace_secrets():
    candidates = (
        Path(__file__).resolve().parent / "workspace_secrets.py",
        Path("/root/workspace_secrets.py"),
    )
    for path in candidates:
        if not path.is_file():
            continue
        spec = importlib.util.spec_from_file_location("modly_workspace_secrets", path)
        if spec is None or spec.loader is None:
            continue
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    raise ImportError("modal/workspace_secrets.py is missing")


TOKEN_SECRETS = _load_workspace_secrets().workspace_token_secrets(modal.Secret)

models_vol = modal.Volume.from_name("modly-models", create_if_missing=True)
workspace_vol = modal.Volume.from_name("modly-workspace", create_if_missing=True)
extensions_vol = modal.Volume.from_name("modly-extensions", create_if_missing=True)

VOLUMES = {
    MODELS_DIR: models_vol,
    WORKSPACE_DIR: workspace_vol,
    EXTENSIONS_DIR: extensions_vol,
}

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "libgl1", "libglib2.0-0")
    .pip_install_from_requirements(str(REPO_API / "requirements.txt"))
    .env(
        {
            "MODELS_DIR": MODELS_DIR,
            "WORKSPACE_DIR": WORKSPACE_DIR,
            "EXTENSIONS_DIR": EXTENSIONS_DIR,
            "MODLY_RUNTIME": "modal",
            "MODLY_USE_GPU_WORKER": "1",
            "MODLY_APP_NAME": APP_NAME,
        }
    )
    .add_local_dir(str(REPO_API), remote_path=API_ROOT, ignore=["*.pyc", "__pycache__", ".venv"])
    .add_local_file(
        str(Path(__file__).resolve().parent / "workspace_secrets.py"),
        remote_path="/root/workspace_secrets.py",
    )
)

app = modal.App(APP_NAME, image=image)


def _load_fastapi():
    import sys as _sys

    try:
        models_vol.reload()
        workspace_vol.reload()
        extensions_vol.reload()
    except Exception as exc:  # noqa: BLE001
        print(f"[modal] volume reload failed: {exc}")
    _sys.path.insert(0, str(API_ROOT))
    from main import app as fastapi_app  # type: ignore  # noqa: PLC0415

    return fastapi_app


def _bind_runtime_env() -> None:
    import os
    import sys as _sys

    os.environ.setdefault("MODELS_DIR", MODELS_DIR)
    os.environ.setdefault("WORKSPACE_DIR", WORKSPACE_DIR)
    os.environ.setdefault("EXTENSIONS_DIR", EXTENSIONS_DIR)
    os.environ.setdefault("MODLY_RUNTIME", "modal")
    os.environ.setdefault("MODLY_APP_NAME", APP_NAME)
    _sys.path.insert(0, str(API_ROOT))


OFFICIAL_REPOS = (
    "https://github.com/lightningpixel/modly-hunyuan3d-mini-extension",
    "https://github.com/lightningpixel/modly-triposg-extension",
    "https://github.com/lightningpixel/modly-trellis2-extension",
)


@app.function(
    volumes=VOLUMES,
    secrets=TOKEN_SECRETS,
    timeout=60 * 60,
    **IDLE.cpu_function_kwargs(),
)
@modal.concurrent(max_inputs=20)
@modal.asgi_app()
def fastapi_app():
    """CPU public URL. Do not attach a GPU here — status polling would pin it."""
    return _load_fastapi()


@app.function(
    volumes=VOLUMES,
    secrets=TOKEN_SECRETS,
    timeout=60 * 60,
    cpu=4.0,
    memory=8192,
    **IDLE.cpu_function_kwargs(),
)
def hydrate_official_extensions():
    """CPU: clone official model extensions onto the Volume. No CUDA."""
    _bind_runtime_env()
    installed = _clone_official_extensions()
    extensions_vol.commit()
    return {"cloned": installed, "next": "modal run modal/app.py::setup_official_extensions"}


@app.function(
    volumes=VOLUMES,
    secrets=TOKEN_SECRETS,
    timeout=6 * 60 * 60,
    cpu=8.0,
    memory=16384,
    **IDLE.cpu_function_kwargs(),
)
def hydrate_official_models():
    """CPU: HuggingFace snapshot_download onto modly-models. Do not do this on GPU."""
    _bind_runtime_env()
    downloaded: list[str] = []
    skipped: list[str] = []
    from huggingface_hub import snapshot_download  # noqa: PLC0415
    from services.modal_hydrate import SNAPSHOT_IGNORE, hf_targets_from_extensions  # noqa: PLC0415

    # Read manifests directly so this works before setup.py clears .modly-incomplete.
    for target in hf_targets_from_extensions(Path(EXTENSIONS_DIR), Path(MODELS_DIR)):
        dest = Path(target["dest"])
        if dest.exists() and any(dest.iterdir()):
            skipped.append(target["model_id"])
            continue
        dest.mkdir(parents=True, exist_ok=True)
        snapshot_download(
            repo_id=target["hf_repo"],
            local_dir=str(dest),
            ignore_patterns=list(target["hf_skip_prefixes"]) + SNAPSHOT_IGNORE,
        )
        downloaded.append(target["model_id"])
    models_vol.commit()
    return {"downloaded": downloaded, "skipped": skipped}


@app.function(
    volumes=VOLUMES,
    secrets=TOKEN_SECRETS,
    timeout=60 * 60,
    **IDLE.gpu_function_kwargs(),
)
def setup_official_extensions():
    """GPU: run each official extension's setup.py (CUDA wheels / SM)."""
    _bind_runtime_env()
    from services.extension_install import clear_incomplete  # noqa: PLC0415
    from services.generator_registry import EXTENSIONS_DIR as ext_dir  # noqa: PLC0415

    cloned = _clone_official_extensions() if not _official_extensions_present(ext_dir) else [
        p.name
        for p in ext_dir.iterdir()
        if p.is_dir() and not p.name.startswith(".") and (p / "manifest.json").exists()
    ]
    installed: list[str] = []
    for ext_id in cloned:
        target = ext_dir / ext_id
        if not target.exists():
            continue
        _run_setup_py(target)
        clear_incomplete(ext_dir, ext_id)
        installed.append(ext_id)
    extensions_vol.commit()
    return {"installed": installed, "gpu": list(IDLE.gpu)}


@app.local_entrypoint()
def bake_official_extensions():
    """CPU clone + CPU weight hydrate + GPU setup.py. One command, GPU only for wheels."""
    print("hydrate extensions (CPU)", hydrate_official_extensions.remote())
    print("hydrate models (CPU)", hydrate_official_models.remote())
    print("setup.py (GPU)", setup_official_extensions.remote())


@app.function(
    volumes=VOLUMES,
    secrets=TOKEN_SECRETS,
    timeout=60,
    **IDLE.cpu_function_kwargs(),
)
def dump_recent_runs(limit: int = 20):
    """Read the run ledger after ASGI has scaled to zero."""
    _bind_runtime_env()
    from services.run_tracker import list_snapshots  # noqa: PLC0415

    return list_snapshots(limit)


@app.cls(
    volumes=VOLUMES,
    secrets=TOKEN_SECRETS,
    timeout=IDLE.gpu_timeout_seconds,
    **IDLE.gpu_cls_kwargs(),
)
class GpuGenerator:
    def _boot(self, *, reload_volumes: bool) -> None:
        if reload_volumes:
            models_vol.reload()
            workspace_vol.reload()
            extensions_vol.reload()
        _bind_runtime_env()
        from services.generator_registry import generator_registry  # noqa: PLC0415

        generator_registry.initialize()
        self.registry = generator_registry

    @modal.enter(snap=True)
    def snapshot_runtime(self) -> None:
        """Captured by the memory snapshot after `modal deploy`."""
        self._boot(reload_volumes=False)

    @modal.enter(snap=False)
    def after_restore(self) -> None:
        """Re-read Volumes so a CPU hydrate is visible after snapshot restore."""
        self._boot(reload_volumes=True)

    @modal.exit()
    def shutdown(self) -> None:
        """Drop weights / extension subprocesses as the GPU container dies."""
        try:
            self.registry.unload_all()
        except Exception as exc:  # noqa: BLE001
            print(f"[modal] GpuGenerator.exit unload failed: {exc}")

    @modal.method()
    def generate(self, job_id: str, model_id: str, image_bytes: bytes, params: dict, collection: str = "Default") -> str:
        """Run one image-to-mesh job and persist status in modal.Dict."""
        from services.generators.base import GenerationCancelled
        from services.job_store import get_job_store
        from services.run_tracker import gpu_enter, gpu_leave, gpu_step

        store = get_job_store()
        if store.is_cancelled(job_id):
            gpu_leave(job_id, "cancelled")
            return "cancelled"
        store.update(job_id, status="running", progress=0, step="Loading model")
        gpu_enter(job_id, "Loading model")
        outcome = "error"
        err = ""

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
            if store.is_cancelled(job_id):
                raise GenerationCancelled()
            gen = self.registry.get_active()
            if store.is_cancelled(job_id):
                raise GenerationCancelled()
            workspace_root = Path(WORKSPACE_DIR)
            coll_dir = workspace_root / collection
            coll_dir.mkdir(parents=True, exist_ok=True)
            gen.outputs_dir = coll_dir
            output_path = Path(gen.generate(image_bytes, params, progress_cb))
            try:
                rel = output_path.relative_to(workspace_root)
            except ValueError:
                rel = Path(collection) / output_path.name
            store.update(job_id, status="done", progress=100, output_url=f"/workspace/{rel.as_posix()}")
            gpu_step(job_id, "volume.commit")
            workspace_vol.commit()
            models_vol.commit()
            outcome = "done"
            return rel.as_posix()
        except GenerationCancelled:
            store.update(job_id, status="cancelled")
            outcome = "cancelled"
            raise
        except Exception as exc:  # noqa: BLE001
            store.update(job_id, status="error", error=str(exc))
            outcome = "error"
            err = str(exc)[:500]
            raise
        finally:
            gpu_leave(job_id, outcome, err)
            # Success: keep weights in VRAM for a retry during the linger window.
            # Cancel: drop them so the soon-to-die container is not holding Hunyuan.
            if outcome == "cancelled":
                try:
                    self.registry.unload_all()
                except Exception as exc:  # noqa: BLE001
                    print(f"[modal] generate unload_all failed: {exc}")

    @modal.method()
    def setup_extension(self, ext_id: str) -> str:
        from services.extension_install import clear_incomplete
        from services.generator_registry import EXTENSIONS_DIR as ext_dir

        target = ext_dir / ext_id
        _run_setup_py(target)
        clear_incomplete(ext_dir, ext_id)
        extensions_vol.commit()
        return ext_id


def _official_extensions_present(ext_dir: Path) -> bool:
    if not ext_dir.exists():
        return False
    return any((p / "manifest.json").exists() for p in ext_dir.iterdir() if p.is_dir())


def _clone_official_extensions() -> list[str]:
    from services.extension_install import (
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
        installed.append(ext_id)
    return installed


def _run_setup_py(ext_dir: Path) -> None:
    import subprocess
    import sys as _sys

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
        [_sys.executable, str(setup_py), _sys.executable, str(ext_dir), str(gpu_sm)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr[-4000:] or result.stdout[-4000:] or "setup.py failed")
