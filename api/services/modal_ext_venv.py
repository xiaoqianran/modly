"""Copy an extension venv off a Modal Volume onto local disk.

TripOSG / Hunyuan install torch into `extensions/<id>/venv` on the Volume.
The GPU worker then starts `venv/bin/python runner.py`, which imports torch
through FUSE. That leaves the runner in D-state for tens of minutes with
the L40S at 0% — HUD stuck on "Loading model". Sequential copy + local
import is the workaround until those wheels live in the Image.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Any, Optional

DEFAULT_STAGE_ROOT = "/tmp/modly-ext-venvs"
ENV_ROOT = "MODLY_EXT_VENV_ROOT"


def stage_root() -> Path:
    return Path(os.environ.get(ENV_ROOT) or DEFAULT_STAGE_ROOT)


def staged_venv_python(ext_dir: Path, root: Optional[Path] = None) -> Path:
    base = (root or stage_root()) / Path(ext_dir).name / "venv"
    if os.name == "nt":
        return base / "Scripts" / "python.exe"
    return base / "bin" / "python"


def volume_venv(ext_dir: Path) -> Path:
    return Path(ext_dir) / "venv"


def stage_volume_venv(ext_dir: Path) -> Optional[Path]:
    """Copy `{ext_dir}/venv` to local disk. None when there is nothing to stage."""
    if os.environ.get("MODLY_RUNTIME", "") != "modal":
        return None
    src = volume_venv(ext_dir)
    if not src.is_dir():
        return None
    dest_python = staged_venv_python(ext_dir)
    dest = dest_python.parent.parent
    marker = dest / ".modly-staged"
    if dest_python.exists() and marker.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        shutil.rmtree(dest)
    print(f"[modal] staging Volume venv {src} → {dest}", flush=True)
    shutil.copytree(src, dest, symlinks=True)
    marker.write_text("ok\n", encoding="utf-8")
    os.environ.setdefault(ENV_ROOT, str(stage_root()))
    return dest


def stage_generator_venv(registry: Any, model_id: str) -> Optional[Path]:
    try:
        gen = registry.get_generator(model_id)
    except Exception:  # noqa: BLE001
        return None
    ext_dir = getattr(gen, "ext_dir", None)
    if not ext_dir:
        return None
    return stage_volume_venv(Path(ext_dir))
