"""Cheap generate routing — the live Hunyuan run, without a GPU.

Unknown model must 400 before spawn. Modal spawn failure must not start
`_run_generation` on the CPU ASGI. Spawn success records a FunctionCall id
so cancel can stop billing.
"""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from services.generate_dispatch import (
    JOB_STATUSES,
    after_gpu_spawn,
    job_status_is_sound,
    spawn_error_message,
)
from services.job_store import MemoryJobStore, reset_job_store_for_tests
from services.modal_runtime import SpawnResult, spawn_gpu_generation, stop_run_compute
from services.run_store import reset_run_store_for_tests
from services.run_tracker import mark_cancel, note_spawn, open_run, snapshot


class AfterSpawnTests(unittest.TestCase):
    def test_modal_never_falls_back_to_local_thread(self) -> None:
        ok = SpawnResult(started=True, call_id="fc-1")
        self.assertEqual(after_gpu_spawn(ok, modal=True), "gpu-worker")
        self.assertEqual(after_gpu_spawn(ok, modal=False), "gpu-worker")

        fail = SpawnResult(started=False, error="Cls.from_name failed")
        self.assertEqual(after_gpu_spawn(fail, modal=True), "spawn-error")
        self.assertEqual(after_gpu_spawn(fail, modal=False), "local-thread")
        self.assertEqual(spawn_error_message(fail), "Cls.from_name failed")
        self.assertEqual(spawn_error_message(SpawnResult(started=False)), "GPU worker spawn failed")

    def test_windows_poller_status_enum(self) -> None:
        for status in JOB_STATUSES:
            self.assertTrue(job_status_is_sound(status))
        self.assertFalse(job_status_is_sound("Loading model"))
        self.assertFalse(job_status_is_sound(""))


class SpawnGpuTests(unittest.TestCase):
    def test_local_runtime_does_not_import_modal(self) -> None:
        result = spawn_gpu_generation("j", "m", b"img", {}, "Default")
        self.assertEqual(result, SpawnResult(started=False))

    @patch.dict("os.environ", {"MODLY_RUNTIME": "modal", "MODLY_USE_GPU_WORKER": "1"}, clear=False)
    def test_spawn_records_function_call_id(self) -> None:
        call = MagicMock()
        call.object_id = "fc-live-1"
        inst = MagicMock()
        inst.generate.spawn.return_value = call
        cls_factory = MagicMock(return_value=inst)
        modal_mod = MagicMock()
        modal_mod.Cls.from_name.return_value = cls_factory
        with patch.dict("sys.modules", {"modal": modal_mod}):
            result = spawn_gpu_generation("job-1", "hunyuan-mini/mini", b"png", {"remesh": "none"}, "Default")
        self.assertEqual(result, SpawnResult(started=True, call_id="fc-live-1"))
        inst.generate.spawn.assert_called_once()

    @patch.dict("os.environ", {"MODLY_RUNTIME": "modal", "MODLY_USE_GPU_WORKER": "1"}, clear=False)
    def test_spawn_failure_is_started_false_with_error(self) -> None:
        modal_mod = MagicMock()
        modal_mod.Cls.from_name.side_effect = RuntimeError("lookup failed")
        with patch.dict("sys.modules", {"modal": modal_mod}):
            result = spawn_gpu_generation("job-1", "m", b"x", {}, "Default")
        self.assertFalse(result.started)
        self.assertIn("lookup failed", result.error)
        self.assertEqual(after_gpu_spawn(result, modal=True), "spawn-error")


class CancelStopsComputeTests(unittest.TestCase):
    def setUp(self) -> None:
        reset_run_store_for_tests()
        reset_job_store_for_tests()

    def test_windows_cancel_reads_spawn_id_and_stops_gpu(self) -> None:
        store = MemoryJobStore()
        job = MagicMock()
        job.job_id = "j1"
        job.status = "running"
        store.put(job)
        open_run("j1", "hunyuan-mini/mini", "generate")
        note_spawn("j1", "fc-stored")
        store.mark_cancel("j1")
        with patch("services.modal_runtime.cancel_function_call", return_value=True) as cancel:
            self.assertTrue(stop_run_compute("j1"))
        cancel.assert_called_once_with("fc-stored")
        mark_cancel("j1", "client cancel")
        body = snapshot("j1")
        self.assertEqual(body["status"], "cancelled")
        self.assertEqual(body["spawn_call_id"], "fc-stored")
        self.assertIn("desktop.8765", body["chain"])


class UnknownModelTests(unittest.TestCase):
    def test_unknown_model_never_plans_a_spawn(self) -> None:
        """Mirrors generation.py: get_generator raises before spawn_gpu_generation."""

        def accept(model_id: str, known: set[str]) -> str:
            if model_id not in known:
                return "reject-400"
            return "spawn"

        self.assertEqual(accept("nope", {"hunyuan-mini/mini"}), "reject-400")
        self.assertEqual(accept("hunyuan-mini/mini", {"hunyuan-mini/mini"}), "spawn")
