"""POST /generate/from-image overlay hook — no FastAPI, no GPU."""

from __future__ import annotations

import os
import unittest
from unittest.mock import MagicMock, patch

from services.generate_dispatch import after_gpu_spawn
from services.generation_overlay import cancel, dispatch_from_image, get_job, put_pending
from services.job_store import reset_job_store_for_tests
from services.modal_runtime import SpawnResult
from services.run_store import reset_run_store_for_tests
from services.run_tracker import snapshot


class DispatchFromImageTests(unittest.TestCase):
    def setUp(self) -> None:
        reset_job_store_for_tests()
        reset_run_store_for_tests()

    def _pending(self, job_id: str = "j1") -> MagicMock:
        job = MagicMock()
        job.job_id = job_id
        job.status = "pending"
        job.progress = 0
        job.error = None
        put_pending(job)
        return job

    def test_local_runtime_leaves_the_http_handler_to_start_a_thread(self) -> None:
        self._pending()
        self.assertFalse(dispatch_from_image("j1", "hunyuan-mini/mini", b"png", {}, "Default"))
        self.assertEqual(after_gpu_spawn(SpawnResult(started=False), modal=False), "local-thread")

    @patch.dict(os.environ, {"MODLY_RUNTIME": "modal"}, clear=False)
    def test_gpu_worker_claims_the_http_handler(self) -> None:
        self._pending()
        spawned = SpawnResult(started=True, call_id="fc-live")
        with patch("services.generation_overlay.spawn_gpu_generation", return_value=spawned):
            self.assertTrue(dispatch_from_image("j1", "hunyuan-mini/mini", b"png", {}, "Default"))
        body = snapshot("j1")
        self.assertEqual(body["spawn_call_id"], "fc-live")
        self.assertIn("gpu.worker", body["chain"])

    @patch.dict(os.environ, {"MODLY_RUNTIME": "modal"}, clear=False)
    def test_spawn_error_claims_the_handler_and_does_not_start_a_thread(self) -> None:
        self._pending()
        spawned = SpawnResult(started=False, error="Cls.from_name failed")
        with patch("services.generation_overlay.spawn_gpu_generation", return_value=spawned):
            self.assertTrue(dispatch_from_image("j1", "m", b"x", {}, "Default"))
        job = get_job("j1")
        self.assertEqual(job.status, "error")
        self.assertIn("Cls.from_name failed", job.error)
        body = snapshot("j1")
        self.assertEqual(body["status"], "error")
        self.assertNotIn("gpu.worker", body["chain"])

    def test_cancel_unknown_job_is_false(self) -> None:
        self.assertFalse(cancel("missing"))

    def test_cancel_known_job_is_true(self) -> None:
        self._pending()
        self.assertTrue(cancel("j1"))
        self.assertEqual(get_job("j1").status, "cancelled")
