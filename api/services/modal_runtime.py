"""Optional Modal hooks. Every function no-ops when not running on Modal."""

from __future__ import annotations

import os
from typing import Any


def is_modal_runtime() -> bool:
    return os.environ.get("MODLY_RUNTIME", "") == "modal"


def use_gpu_worker() -> bool:
    return is_modal_runtime() and os.environ.get("MODLY_USE_GPU_WORKER", "1") == "1"


def app_name() -> str:
    return os.environ.get("MODLY_APP_NAME", "modly-backend")


def commit_volume(name: str) -> None:
    if not is_modal_runtime():
        return
    try:
        import modal

        modal.Volume.from_name(name).commit()
    except Exception as exc:  # noqa: BLE001
        print(f"[modal] volume commit {name} failed: {exc}")


def spawn_gpu_generation(
    job_id: str,
    model_id: str,
    image_bytes: bytes,
    params: dict[str, Any],
    collection: str,
) -> bool:
    if not use_gpu_worker():
        return False
    try:
        import modal

        cls = modal.Cls.from_name(app_name(), "GpuGenerator")
        cls().generate.spawn(job_id, model_id, image_bytes, params, collection)
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[modal] GPU spawn failed, using in-process generate: {exc}")
        return False


def spawn_extension_setup(ext_id: str) -> bool:
    if not use_gpu_worker():
        return False
    try:
        import modal

        cls = modal.Cls.from_name(app_name(), "GpuGenerator")
        cls().setup_extension.spawn(ext_id)
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[modal] extension setup spawn failed: {exc}")
        return False
