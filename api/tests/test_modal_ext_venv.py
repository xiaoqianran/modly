from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from services.extension_process import _venv_python
from services.modal_ext_venv import stage_generator_venv, stage_volume_venv, staged_venv_python


class StageVenvTests(unittest.TestCase):
    def test_off_modal_is_a_no_op(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            ext = Path(raw) / "triposg"
            (ext / "venv" / "bin").mkdir(parents=True)
            (ext / "venv" / "bin" / "python").write_text("x", encoding="utf-8")
            self.assertIsNone(stage_volume_venv(ext))

    @patch.dict(os.environ, {"MODLY_RUNTIME": "modal"}, clear=False)
    def test_copies_volume_venv_once(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw) / "stage"
            ext = Path(raw) / "triposg"
            (ext / "venv" / "bin").mkdir(parents=True)
            (ext / "venv" / "bin" / "python").write_text("py", encoding="utf-8")
            (ext / "venv" / "lib").mkdir()
            (ext / "venv" / "lib" / "torch.py").write_text("t", encoding="utf-8")
            with patch.dict(os.environ, {"MODLY_EXT_VENV_ROOT": str(root)}, clear=False):
                dest = stage_volume_venv(ext)
                self.assertIsNotNone(dest)
                self.assertTrue((dest / "bin" / "python").exists())
                self.assertTrue((dest / "lib" / "torch.py").exists())
                first = (dest / "bin" / "python").read_text(encoding="utf-8")
                (ext / "venv" / "bin" / "python").write_text("changed", encoding="utf-8")
                again = stage_volume_venv(ext)
                self.assertEqual(again, dest)
                self.assertEqual((dest / "bin" / "python").read_text(encoding="utf-8"), first)

    def test_venv_python_prefers_staged_copy(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            ext = Path(raw) / "triposg"
            (ext / "venv" / "bin").mkdir(parents=True)
            (ext / "venv" / "bin" / "python").write_text("vol", encoding="utf-8")
            staged = Path(raw) / "stage" / "triposg" / "venv" / "bin"
            staged.mkdir(parents=True)
            (staged / "python").write_text("local", encoding="utf-8")
            self.assertEqual(_venv_python(ext), ext / "venv" / "bin" / "python")
            with patch.dict(os.environ, {"MODLY_EXT_VENV_ROOT": str(Path(raw) / "stage")}, clear=False):
                self.assertEqual(_venv_python(ext), staged / "python")

    def test_stage_generator_uses_ext_dir(self) -> None:
        class Gen:
            ext_dir = None

        class Reg:
            def get_generator(self, model_id: str) -> Gen:
                return Gen()

        self.assertIsNone(stage_generator_venv(Reg(), "triposg/generate"))
        self.assertTrue(str(staged_venv_python(Path("/ext/triposg"))).endswith("triposg/venv/bin/python"))
