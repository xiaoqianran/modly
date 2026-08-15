import unittest

from services.modal_idle import (
    DEFAULT_GPU,
    ModalIdleSettings,
    idle_release_kwargs,
    parse_gpu,
)


class ParseGpuTests(unittest.TestCase):
    def test_empty_is_l40s_only(self) -> None:
        self.assertEqual(parse_gpu(""), DEFAULT_GPU)
        self.assertEqual(parse_gpu("  "), DEFAULT_GPU)

    def test_explicit_tuple_is_honored(self) -> None:
        self.assertEqual(parse_gpu("L40S,A100"), ("L40S", "A100"))

    def test_does_not_silently_add_a100(self) -> None:
        self.assertNotIn("A100", parse_gpu(""))


class IdleReleaseTests(unittest.TestCase):
    def test_scale_to_zero(self) -> None:
        self.assertEqual(
            idle_release_kwargs(5),
            {"scaledown_window": 5, "min_containers": 0, "buffer_containers": 0},
        )


class SettingsTests(unittest.TestCase):
    def test_defaults(self) -> None:
        s = ModalIdleSettings.from_env({})
        self.assertEqual(s.gpu, ("L40S",))
        self.assertEqual(s.cpu_scaledown_window, 8)
        self.assertEqual(s.gpu_scaledown_window, 5)
        self.assertEqual(s.gpu_timeout_seconds, 20 * 60)
        self.assertTrue(s.memory_snapshot)
        self.assertFalse(s.gpu_snapshot)
        cpu = s.cpu_function_kwargs()
        self.assertEqual(cpu["min_containers"], 0)
        self.assertEqual(cpu["scaledown_window"], 8)
        gpu = s.gpu_cls_kwargs()
        self.assertEqual(gpu["gpu"], ["L40S"])
        self.assertEqual(gpu["scaledown_window"], 5)
        self.assertTrue(gpu["enable_memory_snapshot"])
        self.assertNotIn("experimental_options", gpu)

    def test_expensive_gpu_must_be_explicit(self) -> None:
        s = ModalIdleSettings.from_env({"MODLY_GPU": "A100", "MODLY_GPU_SNAPSHOT": "1"})
        self.assertEqual(s.gpu, ("A100",))
        self.assertTrue(s.gpu_snapshot)
        self.assertIn("enable_gpu_snapshot", s.gpu_cls_kwargs()["experimental_options"])

    def test_gpu_snapshot_requires_memory_snapshot(self) -> None:
        s = ModalIdleSettings.from_env(
            {"MODLY_MEMORY_SNAPSHOT": "0", "MODLY_GPU_SNAPSHOT": "1"}
        )
        self.assertFalse(s.memory_snapshot)
        self.assertFalse(s.gpu_snapshot)
