"""Modal entrypoint for the Modly FastAPI backend.

This is the Phase 0 wrapper: same `api/main.py`, three Volumes, CPU ASGI.
It does not start a GPU container and does not embed credentials.

Local (on your machine, never in chat / git):

    pip install modal
    modal token set
    modal serve modal/app.py
    modal deploy modal/app.py

The public URL speaks the existing Modly HTTP contract
(`/health`, `/generate/*`, `/model/*`, `/optimize/*`, `/workspace/*`).
Job state is still in-process in this skeleton — move it to modal.Dict
before you scale past one CPU container (see the ADR).
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
        sys.path.insert(0, str(API_ROOT))
        from services.generator_registry import generator_registry  # noqa: PLC0415

        generator_registry.initialize()
        self.registry = generator_registry

    @modal.method()
    def generate(self, model_id: str, image_bytes: bytes, params: dict, collection: str = "Default") -> str:
        """Run one image-to-mesh job. Returns a workspace-relative POSIX path."""
        self.registry.switch_model(model_id)
        gen = self.registry.get_active()
        coll_dir = WORKSPACE_DIR / collection
        coll_dir.mkdir(parents=True, exist_ok=True)
        gen.outputs_dir = coll_dir
        output_path = Path(gen.generate(image_bytes, params, lambda *_args, **_kwargs: None))
        try:
            rel = output_path.relative_to(WORKSPACE_DIR)
        except ValueError:
            rel = Path(collection) / output_path.name
        workspace_vol.commit()
        return rel.as_posix()
