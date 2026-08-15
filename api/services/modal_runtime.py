"""Optional Modal hooks. Every function no-ops when not running on Modal."""

from __future__ import annotations

import os
from dataclasses import dataclass
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


@dataclass(frozen=True)
class SpawnResult:
    started: bool
    call_id: str = ""
    error: str = ""


def spawn_gpu_generation(
    job_id: str,
    model_id: str,
    image_bytes: bytes,
    params: dict[str, Any],
    collection: str,
) -> SpawnResult:
    if not use_gpu_worker():
        return SpawnResult(started=False)
    try:
        import modal

        cls = modal.Cls.from_name(app_name(), "GpuGenerator")
        call = cls().generate.spawn(job_id, model_id, image_bytes, params, collection)
        call_id = getattr(call, "object_id", None) or getattr(call, "call_id", "") or ""
        if not call_id:
            print("[modal] spawn succeeded but FunctionCall id is empty — cannot cancel later")
        return SpawnResult(started=True, call_id=str(call_id))
    except Exception as exc:  # noqa: BLE001
        print(f"[modal] GPU spawn failed: {exc}")
        return SpawnResult(started=False, error=str(exc))


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


def _function_call_cls():
    import modal

    fc = getattr(modal, "FunctionCall", None)
    if fc is not None:
        return fc
    from modal.functions import FunctionCall

    return FunctionCall


def cancel_function_call(call_id: str) -> bool:
    """Stop a spawned GPU call so a failed/cancelled job does not keep billing.

    `terminate_containers=True` is required: generate() only checks cancel
    between progress ticks. A hang inside the model never sees the flag.
    """
    if not call_id or not is_modal_runtime():
        return False
    try:
        call = _function_call_cls().from_id(call_id)
        try:
            call.cancel(terminate_containers=True)
        except TypeError:
            call.cancel()
        print(f"[modal] cancelled FunctionCall {call_id}")
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[modal] FunctionCall.cancel({call_id}) failed: {exc}")
        return False


def stop_run_compute(job_id: str) -> bool:
    """Cancel the GPU FunctionCall recorded on this run, if any."""
    try:
        from services.run_store import get_run_store

        record = get_run_store().get(job_id)
        if record is None or not record.spawn_call_id:
            return False
        return cancel_function_call(record.spawn_call_id)
    except Exception as exc:  # noqa: BLE001
        print(f"[modal] stop_run_compute failed: {exc}")
        return False
