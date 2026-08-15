"""Persist RunRecord. Memory locally; modal.Dict on Modal."""

from __future__ import annotations

import os
from typing import Optional

from services.run_ledger import RunRecord

_INDEX_KEY = "_index"
_MAX_INDEX = 80


def is_modal_runtime() -> bool:
    return os.environ.get("MODLY_RUNTIME", "") == "modal"


class MemoryRunStore:
    def __init__(self) -> None:
        self._runs: dict[str, dict] = {}
        self._index: list[str] = []

    def put(self, record: RunRecord) -> None:
        self._runs[record.job_id] = record.payload()
        if record.job_id in self._index:
            self._index.remove(record.job_id)
        self._index.insert(0, record.job_id)
        self._index = self._index[:_MAX_INDEX]

    def get(self, job_id: str) -> Optional[RunRecord]:
        raw = self._runs.get(job_id)
        return RunRecord.from_dict(raw) if raw else None

    def list_ids(self, limit: int = 20) -> list[str]:
        return self._index[: max(1, min(limit, _MAX_INDEX))]


class ModalRunStore:
    def __init__(self) -> None:
        import modal

        self._runs = modal.Dict.from_name("modly-runs", create_if_missing=True)

    def put(self, record: RunRecord) -> None:
        self._runs[record.job_id] = record.payload()
        index = list(self._runs.get(_INDEX_KEY) or [])
        if record.job_id in index:
            index.remove(record.job_id)
        index.insert(0, record.job_id)
        self._runs[_INDEX_KEY] = index[:_MAX_INDEX]

    def get(self, job_id: str) -> Optional[RunRecord]:
        raw = self._runs.get(job_id)
        if not raw or not isinstance(raw, dict):
            return None
        return RunRecord.from_dict(raw)

    def list_ids(self, limit: int = 20) -> list[str]:
        index = list(self._runs.get(_INDEX_KEY) or [])
        return [i for i in index if i != _INDEX_KEY][: max(1, min(limit, _MAX_INDEX))]


_STORE: Optional[MemoryRunStore | ModalRunStore] = None


def get_run_store() -> MemoryRunStore | ModalRunStore:
    global _STORE
    if _STORE is None:
        _STORE = ModalRunStore() if is_modal_runtime() else MemoryRunStore()
    return _STORE


def reset_run_store_for_tests() -> None:
    global _STORE
    _STORE = MemoryRunStore()
