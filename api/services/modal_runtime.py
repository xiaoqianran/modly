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


def reload_volume(name: str) -> None:
    if not is_modal_runtime():
        return
    try:
        import modal

        modal.Volume.from_name(name).reload()
    except Exception as exc:  # noqa: BLE001
        print(f"[modal] volume reload {name} failed: {exc}")


def weights_ready(model_id: str) -> bool:
    """True when this model already has files on modly-models (after reload)."""
    reload_volume("modly-models")
    try:
        from services.generator_registry import generator_registry
        from services.gpu_job_steps import model_weights_ready

        return model_weights_ready(generator_registry, model_id)
    except Exception:  # noqa: BLE001
        return False


def spawn_prepare_and_gpu(
    job_id: str,
    model_id: str,
    image_bytes: bytes,
    params: dict[str, Any],
    collection: str,
) -> SpawnResult:
    """CPU Function: HuggingFace pull, then spawn GpuGenerator. No GPU during download."""
    if not use_gpu_worker():
        return SpawnResult(started=False)
    try:
        import modal

        fn = modal.Function.from_name(app_name(), "prepare_and_spawn_gpu")
        call = fn.spawn(job_id, model_id, image_bytes, params, collection)
        call_id = getattr(call, "object_id", None) or getattr(call, "call_id", "") or ""
        if not call_id:
            print("[modal] prepare spawn succeeded but FunctionCall id is empty")
        return SpawnResult(started=True, call_id=str(call_id))
    except Exception as exc:  # noqa: BLE001
        print(f"[modal] prepare_and_spawn_gpu failed: {exc}")
        return SpawnResult(started=False, error=str(exc))


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
        hold_gpu_for_retry()
        return SpawnResult(started=True, call_id=str(call_id))
    except Exception as exc:  # noqa: BLE001
        print(f"[modal] GPU spawn failed: {exc}")
        return SpawnResult(started=False, error=str(exc))


_hydrate_official_spawned = False


def reset_hydrate_spawn_for_tests() -> None:
    global _hydrate_official_spawned
    _hydrate_official_spawned = False


def spawn_hydrate_official_extensions() -> bool:
    """CPU clone of official repos onto the Volume. At most once per container."""
    global _hydrate_official_spawned
    if _hydrate_official_spawned or not is_modal_runtime():
        return False
    try:
        import modal

        fn = modal.Function.from_name(app_name(), "hydrate_official_extensions")
        fn.spawn()
        _hydrate_official_spawned = True
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[modal] hydrate_official_extensions spawn failed: {exc}")
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


def _function_call_cls():
    import modal

    fc = getattr(modal, "FunctionCall", None)
    if fc is not None:
        return fc
    from modal.functions import FunctionCall

    return FunctionCall


def cancel_function_call(call_id: str) -> bool:
    """Stop a spawned GPU call so a failed/cancelled job does not keep billing.

    Try `terminate_containers=True` first. Some Modal workspaces reject that
    flag (`terminate_containers must be false`); fall back to a plain cancel
    so we still stop the FunctionCall.
    """
    if not call_id or not is_modal_runtime():
        return False
    try:
        call = _function_call_cls().from_id(call_id)
        try:
            call.cancel(terminate_containers=True)
        except Exception as first:  # noqa: BLE001
            try:
                call.cancel()
            except Exception as second:  # noqa: BLE001
                print(f"[modal] FunctionCall.cancel({call_id}) failed: {first}; fallback: {second}")
                return False
        print(f"[modal] cancelled FunctionCall {call_id}")
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[modal] FunctionCall.cancel({call_id}) failed: {exc}")
        return False


def _set_gpu_autoscaler(*, scaledown_window: int) -> bool:
    if not is_modal_runtime():
        return False
    try:
        import modal

        inst = modal.Cls.from_name(app_name(), "GpuGenerator")()
        updater = getattr(inst, "update_autoscaler", None)
        if updater is None:
            return False
        updater(min_containers=0, buffer_containers=0, scaledown_window=scaledown_window)
        print(f"[modal] GpuGenerator autoscaler scaledown={scaledown_window}s min=0")
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[modal] update_autoscaler failed: {exc}")
        return False


def hold_gpu_for_retry() -> bool:
    """Successful spawn: keep the loaded model around for the next Generate."""
    from services.modal_prefs import linger_seconds

    return _set_gpu_autoscaler(scaledown_window=linger_seconds())


def release_gpu_pool() -> bool:
    """Cancel / timeout: drop the GPU container quickly. Next Generate restores linger."""
    from services.modal_idle import DEFAULT_GPU_DROP_WINDOW

    return _set_gpu_autoscaler(scaledown_window=DEFAULT_GPU_DROP_WINDOW)


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
