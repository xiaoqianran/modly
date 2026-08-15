import json
import tempfile
import unittest
from pathlib import Path

from services.extension_catalog import list_model_extension_manifests


class ExtensionCatalogTests(unittest.TestCase):
    def test_lists_model_manifests_and_skips_process_and_incomplete(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            model = root / "hunyuan"
            model.mkdir()
            (model / "manifest.json").write_text(json.dumps({
                "id": "hunyuan",
                "type": "model",
                "name": "Hunyuan",
                "nodes": [{"id": "mini", "name": "Mini"}],
            }), encoding="utf-8")

            process = root / "mesh-smoother"
            process.mkdir()
            (process / "manifest.json").write_text(json.dumps({
                "id": "mesh-smoother",
                "type": "process",
                "nodes": [{"id": "smooth"}],
            }), encoding="utf-8")

            incomplete = root / "broken"
            incomplete.mkdir()
            (incomplete / ".modly-incomplete").write_text("x", encoding="utf-8")
            (incomplete / "manifest.json").write_text("{}", encoding="utf-8")

            listed = list_model_extension_manifests(root)
            self.assertEqual([item["id"] for item in listed], ["hunyuan"])

    def test_empty_or_missing_dir(self) -> None:
        self.assertEqual(list_model_extension_manifests(None), [])
        self.assertEqual(list_model_extension_manifests(Path("/definitely-missing-modly-ext")), [])
