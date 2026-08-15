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
