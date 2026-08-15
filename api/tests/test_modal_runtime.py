import unittest
from unittest.mock import MagicMock, patch

from services.modal_runtime import SpawnResult, cancel_function_call, spawn_gpu_generation, stop_run_compute
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
    def test_cancel_terminates_container(self) -> None:
        call = MagicMock()
        fc_cls = MagicMock()
        fc_cls.from_id.return_value = call
        with patch("services.modal_runtime._function_call_cls", return_value=fc_cls):
            self.assertTrue(cancel_function_call("fc-99"))
        fc_cls.from_id.assert_called_once_with("fc-99")
        call.cancel.assert_called_once_with(terminate_containers=True)

    def test_stop_run_compute_reads_spawn_id(self) -> None:
        open_run("j2", "m", "generate")
        note_spawn("j2", "fc-stored")
        with patch("services.modal_runtime.cancel_function_call", return_value=True) as cancel:
            self.assertTrue(stop_run_compute("j2"))
        cancel.assert_called_once_with("fc-stored")
