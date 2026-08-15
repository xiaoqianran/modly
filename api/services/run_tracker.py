"""Safe facade around the run ledger. Routers and GpuGenerator call this.

Never raises — a broken ledger must not take down generate().

Reading a run (`snapshot` / `GET /runs`) also *heals* a leaked GPU:
if a FunctionCall is still billed after the job should have stopped,
we cancel it and close the span so the estimate stops growing.
"""

from __future__ import annotations

import os
import time
from typing import Any, Optional

from services.modal_idle import ModalIdleSettings
from services.run_ledger import TERMINAL, RunRecord
from services.run_store import get_run_store

GPU_TIMEOUT_ERROR = "GPU timeout — FunctionCall cancelled so the container stops billing"


def _now() -> float:
    return time.time()


def _idle() -> ModalIdleSettings:
    return ModalIdleSettings.from_env()


def _gpu_name() -> str:
    idle = _idle()
    return idle.gpu[0] if idle.gpu else "L40S"


def _mutate(job_id: str, fn) -> Optional[RunRecord]:
    try:
        store = get_run_store()
        record = store.get(job_id)
        if record is None:
            return None
        fn(record)
        store.put(record)
        return record
    except Exception as exc:  # noqa: BLE001
        name = getattr(fn, "__name__", "mutate")
        print(f"[run-ledger] {name} failed: {exc}")
        return None


def open_run(job_id: str, model_id: str, source: str) -> None:
    try:
        now = _now()
        remote = os.environ.get("MODLY_RUNTIME", "") == "modal"
        chain = ["desktop.8765"]
        if remote:
            chain.extend(["gateway", "cpu.asgi"])
        else:
            chain.append("cpu.asgi")
        record = RunRecord(
            run_id=job_id,
            job_id=job_id,
            model_id=model_id,
            source=source,
            gpu=_gpu_name() if remote else "",
            status="pending",
            chain=chain,
            created_at=now,
            updated_at=now,
        )
        record.open_span("cpu.accept", now, detail=f"source={source} model={model_id}")
        get_run_store().put(record)
    except Exception as exc:  # noqa: BLE001
        print(f"[run-ledger] open_run failed: {exc}")


def note_hydrate(job_id: str, call_id: str) -> None:
    """CPU weight pull is in flight. spawn_call_id is the CPU FunctionCall (cancellable)."""

    def apply(record: RunRecord) -> None:
        record.spawn_call_id = call_id
        record.status = "running"
        record.open_span("cpu.hydrate", _now(), detail=call_id)

    _mutate(job_id, apply)


def note_spawn(job_id: str, call_id: str) -> None:
    def apply(record: RunRecord) -> None:
        now = _now()
        record.close_span("cpu.hydrate", now, detail="weights ready")
        record.spawn_call_id = call_id
        record.open_span("cpu.spawn_gpu", now, detail=call_id)
        if "gpu.worker" not in record.chain:
            record.chain.append("gpu.worker")

    _mutate(job_id, apply)


def note_spawn_failed(job_id: str, detail: str) -> None:
    def apply(record: RunRecord) -> None:
        now = _now()
        record.close_span("cpu.hydrate", now, detail=detail)
        record.close_span("cpu.spawn_gpu", now, detail=detail)
        record.close_span("cpu.poll", now)
        record.note("error.spawn", now, detail=detail)
        record.status = "error"
        record.error = detail
        record.close_span("cpu.accept", now)

    _mutate(job_id, apply)


def work_enter(job_id: str, name: str, detail: str = "") -> None:
    def apply(record: RunRecord) -> None:
        record.status = "running"
        record.open_span(name, _now(), detail=detail)

    _mutate(job_id, apply)


def gpu_enter(job_id: str, step: str = "enter") -> None:
    work_enter(job_id, "gpu.generate", step)


def gpu_step(job_id: str, detail: str) -> None:
    def apply(record: RunRecord) -> None:
        record.note("gpu.step", _now(), detail=detail)

    _mutate(job_id, apply)


def finish_run(job_id: str, status: str, error: str = "") -> None:
    def apply(record: RunRecord) -> None:
        now = _now()
        final = "cancelled" if record.status == "cancelled" and status == "done" else status
        record.close_span("cpu.poll", now)
        record.close_span("cpu.hydrate", now, detail=final)
        record.close_span("cpu.generate", now, detail=final)
        record.close_span("gpu.generate", now, detail=final)
        record.close_span("cpu.spawn_gpu", now)
        record.close_span("cpu.accept", now)
        record.status = final
        if error:
            record.error = error
            record.note("error", now, detail=error[:500])

    _mutate(job_id, apply)


gpu_leave = finish_run


def heal_run(job_id: str) -> Optional[str]:
    """If GPU is still billed after it should have stopped, cancel and close.

    Returns the leak kind, or None.
    """
    kind: list[str] = []

    def apply(record: RunRecord) -> None:
        now = _now()
        leak = record.leak(now=now, gpu_timeout=_idle().gpu_timeout_seconds)
        if not leak:
            return
        kind.append(str(leak["kind"]))
        record.close_span("gpu.generate", now, detail=str(leak["kind"]))
        record.close_span("cpu.spawn_gpu", now)
        record.close_span("cpu.poll", now)
        if leak["kind"] in ("gpu_over_timeout", "spawn_hung"):
            record.status = "error"
            record.error = str(leak["message"])
            record.note("error.timeout", now, detail=str(leak["message"]))
            record.close_span("cpu.accept", now)

    try:
        _mutate(job_id, apply)
        if kind:
            from services.modal_runtime import release_gpu_pool, stop_run_compute

            stop_run_compute(job_id)
            release_gpu_pool()
        return kind[0] if kind else None
    except Exception as exc:  # noqa: BLE001
        print(f"[run-ledger] heal_run failed: {exc}")
        return None


def apply_status_watch(job_id: str) -> bool:
    """Status-poll hook. True if a hung GPU was cancelled; refresh the job after."""
    if touch_poll(job_id) != "timeout":
        return False
    try:
        from services.job_store import get_job_store

        get_job_store().update(job_id, status="error", error=GPU_TIMEOUT_ERROR)
    except Exception as exc:  # noqa: BLE001
        print(f"[run-ledger] apply_status_watch failed: {exc}")
    return True


def touch_poll(job_id: str) -> Optional[str]:
    """Count a status poll. Heal a leaked GPU. Return 'timeout' if we killed it."""

    def apply(record: RunRecord) -> None:
        if record.status in TERMINAL:
            return
        now = _now()
        record.cpu_polls += 1
        record.updated_at = now
        poll = next((s for s in record.spans if s.name == "cpu.poll"), None)
        if poll is None:
            record.open_span("cpu.poll", now, detail="status")
        else:
            poll.t1 = now
            poll.detail = f"n={record.cpu_polls}"

    _mutate(job_id, apply)
    kind = heal_run(job_id)
    if kind in ("gpu_over_timeout", "spawn_hung"):
        return "timeout"
    return None


def mark_cancel(job_id: str, detail: str = "client cancel") -> None:
    def apply(record: RunRecord) -> None:
        now = _now()
        record.note("cpu.cancel", now, detail=detail)
        record.status = "cancelled"
        record.close_span("cpu.poll", now)
        record.close_span("cpu.hydrate", now, detail="cancelled")
        record.close_span("cpu.generate", now, detail="cancelled")
        record.close_span("gpu.generate", now, detail="cancelled")
        record.close_span("cpu.spawn_gpu", now)
        record.close_span("cpu.accept", now)

    _mutate(job_id, apply)


def snapshot(job_id: str) -> Optional[dict[str, Any]]:
    try:
        heal_run(job_id)
        record = get_run_store().get(job_id)
        if record is None:
            return None
        idle = _idle()
        return record.to_dict(
            now=_now(),
            cpu_scaledown=idle.cpu_scaledown_window,
            gpu_scaledown=idle.gpu_scaledown_window,
            gpu_timeout=idle.gpu_timeout_seconds,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[run-ledger] snapshot failed: {exc}")
        return None


def list_snapshots(limit: int = 20) -> list[dict[str, Any]]:
    try:
        store = get_run_store()
        out: list[dict[str, Any]] = []
        for job_id in store.list_ids(limit):
            snap = snapshot(job_id)
            if snap:
                out.append(snap)
        return out
    except Exception as exc:  # noqa: BLE001
        print(f"[run-ledger] list failed: {exc}")
        return []
