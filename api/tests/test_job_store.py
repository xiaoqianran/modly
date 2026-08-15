import unittest

from services.job_store import MemoryJobStore


class _Job:
    def __init__(self, job_id: str, status: str, progress: int = 0) -> None:
        self.job_id = job_id
        self.status = status
        self.progress = progress


class MemoryJobStoreTests(unittest.TestCase):
    def test_put_get_update_and_cancel(self) -> None:
        store = MemoryJobStore()
        store.put(_Job("j1", "pending"))
        self.assertEqual(store.get("j1").status, "pending")
        store.update("j1", status="running", progress=10)
        self.assertEqual(store.get("j1").progress, 10)
        store.mark_cancel("j1")
        self.assertTrue(store.is_cancelled("j1"))
        self.assertEqual(store.get("j1").status, "cancelled")
        self.assertTrue(store.cancel_event("j1").is_set())

    def test_update_does_not_resurrect_cancelled(self) -> None:
        store = MemoryJobStore()
        store.put(_Job("j1", "pending"))
        store.mark_cancel("j1")
        store.update("j1", status="running", progress=1)
        self.assertEqual(store.get("j1").status, "cancelled")

    def test_update_does_not_resurrect_done_or_error(self) -> None:
        store = MemoryJobStore()
        store.put(_Job("done-1", "done"))
        store.update("done-1", status="running", progress=1)
        self.assertEqual(store.get("done-1").status, "done")
        store.put(_Job("err-1", "error"))
        store.update("err-1", status="running", step="Loading model")
        self.assertEqual(store.get("err-1").status, "error")
