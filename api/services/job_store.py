"""Job status store.

Local: in-process dict (same as the original `_jobs`).
Modal: modal.Dict so POST /generate and GET /status can land on different containers.
"""

from __future__ import annotations

import os
import threading
import time
from typing import Any, Optional, Protocol

_JOB_TTL = 1800


def is_modal_runtime() -> bool:
    return os.environ.get("MODLY_RUNTIME", "") == "modal"


class JobStore(Protocol):
    def put(self, job: Any) -> None: ...
    def get(self, job_id: str) -> Any: ...
    def update(self, job_id: str, **fields: object) -> Any: ...
    def mark_cancel(self, job_id: str) -> None: ...
    def is_cancelled(self, job_id: str) -> bool: ...
    def cancel_event(self, job_id: str) -> threading.Event: ...
    def purge(self) -> None: ...


class MemoryJobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, Any] = {}
        self._cancelled: set[str] = set()
        self._events: dict[str, threading.Event] = {}
        self._completed_at: dict[str, float] = {}

    def put(self, job: Any) -> None:
        self._jobs[job.job_id] = job
        if job.job_id not in self._events:
            self._events[job.job_id] = threading.Event()

    def get(self, job_id: str) -> Any:
        return self._jobs.get(job_id)

    def update(self, job_id: str, **fields: object) -> Any:
        job = self._jobs.get(job_id)
        if job is None:
            return None
        incoming = fields.get("status")
        if getattr(job, "status", None) in ("done", "error", "cancelled") and incoming == "running":
            return job
        for key, value in fields.items():
            setattr(job, key, value)
        if fields.get("status") in ("done", "error", "cancelled"):
            self._completed_at[job_id] = time.monotonic()
        return job

    def mark_cancel(self, job_id: str) -> None:
        self._cancelled.add(job_id)
        event = self._events.get(job_id)
        if event:
            event.set()
        job = self._jobs.get(job_id)
        if job and job.status in ("pending", "running"):
            job.status = "cancelled"
            self._completed_at[job_id] = time.monotonic()

    def is_cancelled(self, job_id: str) -> bool:
        return job_id in self._cancelled

    def cancel_event(self, job_id: str) -> threading.Event:
        if job_id not in self._events:
            self._events[job_id] = threading.Event()
        return self._events[job_id]

    def purge(self) -> None:
        cutoff = time.monotonic() - _JOB_TTL
        stale = [jid for jid, t in self._completed_at.items() if t < cutoff]
        for jid in stale:
            self._jobs.pop(jid, None)
            self._cancelled.discard(jid)
            self._events.pop(jid, None)
            self._completed_at.pop(jid, None)


class ModalJobStore:
    def __init__(self) -> None:
        import modal

        self._jobs = modal.Dict.from_name("modly-jobs", create_if_missing=True)
        self._cancel = modal.Dict.from_name("modly-job-cancel", create_if_missing=True)
        self._events: dict[str, threading.Event] = {}

    def put(self, job: Any) -> None:
        payload = job.model_dump() if hasattr(job, "model_dump") else dict(job)
        if getattr(job, "status", None) in ("done", "error", "cancelled"):
            payload["_completed_at"] = time.time()
        self._jobs[job.job_id] = payload
        if job.job_id not in self._events:
            self._events[job.job_id] = threading.Event()

    def get(self, job_id: str) -> Any:
        from schemas.generation import JobStatus

        raw = self._jobs.get(job_id)
        if not raw:
            return None
        data = {k: v for k, v in raw.items() if not k.startswith("_")}
        return JobStatus(**data)

    def update(self, job_id: str, **fields: object) -> Any:
        job = self.get(job_id)
        if job is None:
            return None
        incoming = fields.get("status")
        if job.status in ("done", "error", "cancelled") and incoming == "running":
            return job
        for key, value in fields.items():
            setattr(job, key, value)
        self.put(job)
        return job

    def mark_cancel(self, job_id: str) -> None:
        self._cancel[job_id] = True
        event = self._events.get(job_id)
        if event:
            event.set()
        self.update(job_id, status="cancelled")

    def is_cancelled(self, job_id: str) -> bool:
        return bool(self._cancel.get(job_id))

    def cancel_event(self, job_id: str) -> threading.Event:
        if job_id not in self._events:
            self._events[job_id] = threading.Event()
        return self._events[job_id]

    def purge(self) -> None:
        cutoff = time.time() - _JOB_TTL
        try:
            keys = list(self._jobs.keys())
        except Exception:
            return
        for jid in keys:
            raw = self._jobs.get(jid) or {}
            completed = raw.get("_completed_at")
            if completed and completed < cutoff:
                self._jobs.pop(jid, None)
                self._cancel.pop(jid, None)


_STORE: Optional[JobStore] = None


def get_job_store() -> JobStore:
    global _STORE
    if _STORE is None:
        _STORE = ModalJobStore() if is_modal_runtime() else MemoryJobStore()
    return _STORE


def reset_job_store_for_tests() -> None:
    global _STORE
    _STORE = MemoryJobStore()
