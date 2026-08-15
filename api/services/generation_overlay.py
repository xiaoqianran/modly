"""The only Modal-aware hook generation.py / workflow_runs.py should import.

Keeps those routers looking like upstream: create a job, maybe return early
if a GPU worker took it, otherwise run the local thread.
"""

from __future__ import annotations

from typing import Any, Optional

from services.generate_dispatch import after_gpu_spawn, spawn_error_message
from services.gpu_job_steps import STEP_DOWNLOADING, STEP_STARTING_GPU
from services.job_store import get_job_store
from services.modal_runtime import (
    commit_volume,
    is_modal_runtime,
    release_gpu_pool,
    spawn_gpu_generation,
    spawn_prepare_and_gpu,
    stop_run_compute,
    weights_ready,
)
from services.run_tracker import (
    apply_status_watch,
    finish_run,
    mark_cancel,
    note_hydrate,
    note_spawn,
    note_spawn_failed,
    open_run,
    work_enter,
)


def purge() -> None:
    get_job_store().purge()


def put_pending(job: Any) -> None:
    store = get_job_store()
    store.put(job)
    store.cancel_event(job.job_id)


def dispatch_from_image(
    job_id: str,
    model_id: str,
    image_bytes: bytes,
    params: dict,
    collection: str,
    *,
    kind: str = "generate",
) -> bool:
    """True = the HTTP handler should return now (GPU worker or spawn error)."""
    open_run(job_id, model_id, kind)
    if is_modal_runtime() and not weights_ready(model_id):
        spawned = spawn_prepare_and_gpu(job_id, model_id, image_bytes, params, collection)
        plan = after_gpu_spawn(spawned, modal=True)
        if plan == "gpu-worker":
            note_hydrate(job_id, spawned.call_id)
            get_job_store().update(job_id, status="running", step=STEP_DOWNLOADING)
            return True
        err = spawn_error_message(spawned)
        note_spawn_failed(job_id, err)
        get_job_store().update(job_id, status="error", error=err)
        return True
    spawned = spawn_gpu_generation(job_id, model_id, image_bytes, params, collection)
    plan = after_gpu_spawn(spawned, modal=is_modal_runtime())
    if plan == "gpu-worker":
        note_spawn(job_id, spawned.call_id)
        get_job_store().update(job_id, step=STEP_STARTING_GPU)
        return True
    if plan == "spawn-error":
        err = spawn_error_message(spawned)
        note_spawn_failed(job_id, err)
        get_job_store().update(job_id, status="error", error=err)
        return True
    return False


def get_job(job_id: str) -> Any:
    job = get_job_store().get(job_id)
    if job is None:
        return None
    if apply_status_watch(job_id):
        return get_job_store().get(job_id) or job
    return job


def cancel(job_id: str, reason: str = "client cancel") -> bool:
    store = get_job_store()
    if store.get(job_id) is None:
        return False
    store.mark_cancel(job_id)
    stop_run_compute(job_id)
    release_gpu_pool()
    mark_cancel(job_id, reason)
    return True


def is_cancelled(job_id: str) -> bool:
    return get_job_store().is_cancelled(job_id)


def cancel_event(job_id: str) -> Any:
    return get_job_store().cancel_event(job_id)


def update(job_id: str, **fields: object) -> Any:
    return get_job_store().update(job_id, **fields)


def note_local_start(job_id: str) -> None:
    work_enter(job_id, "cpu.generate", "local")


def note_local_finish(job_id: str, status: str, error: Optional[str] = None) -> None:
    if status == "done":
        commit_volume("modly-workspace")
    finish_run(job_id, status, error)
