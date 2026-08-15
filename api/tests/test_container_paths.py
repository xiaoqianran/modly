"""Modal Image.add_local_dir remote_path must be a POSIX absolute string.

Official: https://modal.com/docs/reference/modal.Image
  image.add_local_dir("./src", "/app/src")
  image.add_local_dir(..., remote_path="/assets")

The Modal client rejects anything that does not start with "/":
  InvalidError: image.add_local_dir() currently only supports absolute remote_path values

On Windows, str(pathlib.Path("/root/api")) is "\\root\\api".
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path, PureWindowsPath


ROOT = Path(__file__).resolve().parents[2]


class ContainerPathTests(unittest.TestCase):
    def test_windows_pathlib_breaks_modal_absolute_check(self) -> None:
        windows = PureWindowsPath("/root/api")
        self.assertEqual(str(windows), "\\root\\api")
        self.assertFalse(str(windows).startswith("/"))
        self.assertEqual(windows.as_posix(), "/root/api")

    def test_app_py_passes_posix_literals_to_modal(self) -> None:
        src = (ROOT / "modal" / "app.py").read_text(encoding="utf-8")
        self.assertIn('API_ROOT = "/root/api"', src)
        self.assertIn('MODELS_DIR = "/modly/models"', src)
        self.assertIn('WORKSPACE_DIR = "/modly/workspace"', src)
        self.assertIn('EXTENSIONS_DIR = "/modly/extensions"', src)
        self.assertNotIn("API_ROOT = Path(", src)
        self.assertNotIn("remote_path=str(API_ROOT)", src)
        self.assertIn("remote_path=API_ROOT", src)
        self.assertIn('remote_path="/root/workspace_secrets.py"', src)
        self.assertRegex(src, r'add_local_dir\(\s*str\(REPO_API\),\s*remote_path=API_ROOT')
        for name in ("API_ROOT", "MODELS_DIR", "WORKSPACE_DIR", "EXTENSIONS_DIR"):
            match = re.search(rf'^{name} = "([^"]+)"', src, re.M)
            self.assertIsNotNone(match, name)
            self.assertTrue(match.group(1).startswith("/"), name)
