import unittest
from unittest.mock import MagicMock, patch

from services.modal_runtime import (
    SpawnResult,
    cancel_function_call,
    hold_gpu_for_retry,
    release_gpu_pool,
    spawn_gpu_generation,
    stop_run_compute,
)
from services.run_store import reset_run_store_for_tests
from services.run_tracker import note_spawn, open_run


class SpawnResultTests(unittest.TestCase):
    def test_local_spawn_is_a_no_op(self) -> None:
        result = spawn_gpu_generation("j", "m", b"img", {}, "Default")
        self.assertEqual(result, SpawnResult(started=False))

    def test_cancel_without_modal_is_false(self) -> None:
        self.assertFalse(cancel_function_call("fc-1"))
        self.assertFalse(cancel_function_call(""))


class CancelTests(unittest.TestCase):
    def setUp(self) -> None:
        reset_run_store_for_tests()

    def test_stop_run_compute_without_call_id(self) -> None:
        open_run("j", "m", "generate")
        self.assertFalse(stop_run_compute("j"))

    @patch.dict("os.environ", {"MODLY_RUNTIME": "modal"}, clear=False)
    def test_cancel_falls_back_when_terminate_rejected(self) -> None:
        call = MagicMock()
        call.cancel.side_effect = [RuntimeError("terminate_containers must be false"), None]
        fc_cls = MagicMock()
        fc_cls.from_id.return_value = call
        with patch("services.modal_runtime._function_call_cls", return_value=fc_cls):
            self.assertTrue(cancel_function_call("fc-99"))
        self.assertEqual(call.cancel.call_count, 2)
        call.cancel.assert_any_call(terminate_containers=True)
        call.cancel.assert_any_call()

    def test_stop_run_compute_reads_spawn_id(self) -> None:
        open_run("j2", "m", "generate")
        note_spawn("j2", "fc-stored")
        with patch("services.modal_runtime.cancel_function_call", return_value=True) as cancel:
            self.assertTrue(stop_run_compute("j2"))
        cancel.assert_called_once_with("fc-stored")


class GpuPoolTests(unittest.TestCase):
    def test_hold_and_release_are_no_ops_off_modal(self) -> None:
        self.assertFalse(hold_gpu_for_retry())
        self.assertFalse(release_gpu_pool())

    @patch.dict("os.environ", {"MODLY_RUNTIME": "modal"}, clear=False)
    def test_cancel_drops_pool_fast_and_spawn_restores_linger(self) -> None:
        inst = MagicMock()
        cls = MagicMock(return_value=inst)
        modal_mod = MagicMock()
        modal_mod.Cls.from_name.return_value = cls
        with patch.dict("sys.modules", {"modal": modal_mod}):
            self.assertTrue(release_gpu_pool())
            inst.update_autoscaler.assert_called_with(
                min_containers=0, buffer_containers=0, scaledown_window=2
            )
            inst.update_autoscaler.reset_mock()
            self.assertTrue(hold_gpu_for_retry())
            inst.update_autoscaler.assert_called_with(
                min_containers=0, buffer_containers=0, scaledown_window=90
            )
