"""Where POST /generate/from-image continues after GPU spawn.

The FastAPI router stays a thin HTTP shell. GpuGenerator.generate is the
GPU worker. This module is the only place that decides *whether* a job
runs on the Modal GPU class, errors out, or falls back to a local thread.

Tests import this file. They must not import FastAPI, pydantic, or modal.
"""

from __future__ import annotations

from typing import Literal

from services.modal_runtime import SpawnResult

GenerateKind = Literal["gpu-worker", "spawn-error", "local-thread"]

# JobStatus.status values the Windows poller (useApi.pollJobStatus) accepts.
JOB_STATUSES = frozenset({"pending", "running", "done", "error", "cancelled"})


def after_gpu_spawn(spawned: SpawnResult, *, modal: bool) -> GenerateKind:
    """Modal must never fall back to the laptop / CPU-ASGI generate thread.

    Live lesson: a failed `GpuGenerator.generate.spawn` used to call
    `_run_generation` on the CPU container. The UI sat on "Loading model"
    while either nothing ran, or a leaked GPU kept billing. On Modal the
    job becomes `error` and no local thread starts.
    """
    if spawned.started:
        return "gpu-worker"
    if modal:
        return "spawn-error"
    return "local-thread"


def spawn_error_message(spawned: SpawnResult) -> str:
    return spawned.error or "GPU worker spawn failed"


def job_status_is_sound(status: str) -> bool:
    return status in JOB_STATUSES
