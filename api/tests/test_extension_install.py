import json
import tempfile
import unittest
from pathlib import Path

from services.extension_install import extract_extension, github_api_headers, parse_github_repo, remove_extension


class ExtensionInstallTests(unittest.TestCase):
    def test_parse_github_repo(self) -> None:
        self.assertEqual(
            parse_github_repo("https://github.com/lightningpixel/modly-trellis2-extension"),
            ("lightningpixel", "modly-trellis2-extension"),
        )
        with self.assertRaises(ValueError):
            parse_github_repo("https://gitlab.com/foo/bar")

    def test_extract_and_remove(self) -> None:
        import io
        import tarfile

        with tempfile.TemporaryDirectory() as raw:
            dest = Path(raw) / "exts"
            src = Path(raw) / "src" / "repo"
            src.mkdir(parents=True)
            (src / "manifest.json").write_text(json.dumps({
                "id": "trellis2",
                "type": "model",
                "nodes": [{"id": "gen"}],
            }), encoding="utf-8")
            (src / "generator.py").write_text("#", encoding="utf-8")

            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode="w:gz") as tar:
                tar.add(src, arcname="owner-repo-sha")
            ext_id = extract_extension(buf.getvalue(), dest, "https://github.com/o/r")
            self.assertEqual(ext_id, "trellis2")
            self.assertTrue((dest / "trellis2" / ".modly-incomplete").exists())
            remove_extension(dest, "trellis2")
            self.assertFalse((dest / "trellis2").exists())

    def test_github_headers_omit_authorization_without_token(self) -> None:
        import os
        from unittest.mock import patch

        with patch.dict(os.environ, {"GITHUB_TOKEN": ""}, clear=False):
            headers = github_api_headers()
        self.assertEqual(headers["User-Agent"], "modly")
        self.assertNotIn("Authorization", headers)

    def test_github_headers_send_bearer_when_token_present(self) -> None:
        import os
        from unittest.mock import patch

        with patch.dict(os.environ, {"GITHUB_TOKEN": "ghs_test_not_a_real_secret"}, clear=False):
            headers = github_api_headers()
        self.assertTrue(headers["Authorization"].startswith("Bearer "))
        self.assertIn("ghs_test_not_a_real_secret", headers["Authorization"])
