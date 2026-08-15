import unittest
from unittest.mock import MagicMock, patch

from services.modal_idle import DEFAULT_GPU_SCALEDOWN
from services.modal_prefs import (
    DEFAULT_LINGER_SECONDS,
    MAX_LINGER_SECONDS,
    MIN_LINGER_SECONDS,
    clamp_linger_seconds,
    linger_seconds,
    normalize_gpu,
    preferred_gpu,
    public_modal_prefs,
    reset_modal_prefs_for_tests,
    set_modal_prefs,
)


class ModalPrefsTests(unittest.TestCase):
    def setUp(self) -> None:
        reset_modal_prefs_for_tests()

    def tearDown(self) -> None:
        reset_modal_prefs_for_tests()

    def test_default_linger_is_60(self) -> None:
        self.assertEqual(DEFAULT_GPU_SCALEDOWN, 60)
        self.assertEqual(DEFAULT_LINGER_SECONDS, 60)
        self.assertEqual(linger_seconds({}), 60)
        self.assertEqual(public_modal_prefs({})["lingerSeconds"], 60)
        self.assertEqual(public_modal_prefs({})["gpu"], "L40S")

    def test_clamp_and_normalize(self) -> None:
        self.assertEqual(clamp_linger_seconds(1), MIN_LINGER_SECONDS)
        self.assertEqual(clamp_linger_seconds(99999), MAX_LINGER_SECONDS)
        self.assertEqual(clamp_linger_seconds("45"), 45)
        self.assertEqual(clamp_linger_seconds("nope"), 60)
        self.assertEqual(normalize_gpu(""), "L40S")
        self.assertEqual(normalize_gpu("a100"), "A100")
        self.assertEqual(normalize_gpu("mystery"), "L40S")

    def test_override_beats_env(self) -> None:
        set_modal_prefs(linger_seconds=45, gpu="A100", persist=False)
        self.assertEqual(
            linger_seconds({"MODLY_GPU_SCALEDOWN": "90"}),
            45,
        )
        self.assertEqual(preferred_gpu({"MODLY_GPU": "L4"}), "A100")
        body = public_modal_prefs({"MODLY_GPU": "L40S"})
        self.assertEqual(body["gpu"], "A100")
        self.assertEqual(body["deployedGpu"], "L40S")
        self.assertFalse(body["gpuMatchesDeploy"])
        self.assertTrue(body["lingerAppliesImmediately"])
        self.assertTrue(body["gpuAppliesOnDeploy"])

    def test_env_used_when_no_override(self) -> None:
        self.assertEqual(linger_seconds({"MODLY_GPU_SCALEDOWN": "30"}), 30)
        self.assertEqual(preferred_gpu({"MODLY_GPU": "H100"}), "H100")

    def test_does_not_persist_off_modal(self) -> None:
        with patch.dict("os.environ", {"MODLY_RUNTIME": "local"}, clear=False):
            body = set_modal_prefs(linger_seconds=20, persist=True)
        self.assertEqual(body["lingerSeconds"], 20)

    def test_load_from_dict_on_modal(self) -> None:
        store = {"prefs": {"lingerSeconds": 40, "gpu": "L4"}}
        modal_mod = MagicMock()
        modal_mod.Dict.from_name.return_value = store
        with patch.dict("os.environ", {"MODLY_RUNTIME": "modal"}, clear=False):
            with patch.dict("sys.modules", {"modal": modal_mod}):
                reset_modal_prefs_for_tests()
                self.assertEqual(linger_seconds(), 40)
                self.assertEqual(preferred_gpu(), "L4")
