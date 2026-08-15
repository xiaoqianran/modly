import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from services.extension_catalog import list_extension_catalog, list_model_extension_manifests
from services.official_extension_stubs import official_workflow_ids


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

    def test_includes_incomplete_official_when_asked(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            pending = root / "hunyuan3d-mini"
            pending.mkdir()
            (pending / ".modly-incomplete").write_text("installing", encoding="utf-8")
            (pending / "manifest.json").write_text(json.dumps({
                "id": "hunyuan3d-mini",
                "type": "model",
                "nodes": [{"id": "generate"}],
            }), encoding="utf-8")
            self.assertEqual(list_model_extension_manifests(root), [])
            listed = list_model_extension_manifests(root, include_incomplete_official=True)
            self.assertEqual([item["id"] for item in listed], ["hunyuan3d-mini"])

    def test_catalog_fills_official_stubs_and_requests_hydrate(self) -> None:
        with patch("services.modal_runtime.spawn_hydrate_official_extensions") as spawn:
            listed = list_extension_catalog(Path("/definitely-missing-modly-ext"))
        self.assertEqual(
            [item["id"] for item in listed],
            ["hunyuan3d-mini", "triposg", "trellis-2"],
        )
        self.assertIn("hunyuan3d-mini/generate", official_workflow_ids())
        self.assertIn("triposg/generate", official_workflow_ids())
        self.assertIn("trellis-2/trellis-2", official_workflow_ids())
        generate = next(n for n in listed[0]["nodes"] if n["id"] == "generate")
        self.assertEqual(generate["input"], "image")
        self.assertEqual(generate["output"], "mesh")
        spawn.assert_called_once()

    def test_catalog_keeps_incomplete_official_and_does_not_duplicate_stubs(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            pending = root / "hunyuan3d-mini"
            pending.mkdir()
            (pending / ".modly-incomplete").write_text("installing", encoding="utf-8")
            (pending / "manifest.json").write_text(json.dumps({
                "id": "hunyuan3d-mini",
                "type": "model",
                "name": "From Volume",
                "nodes": [{"id": "generate", "name": "Generate Mesh"}],
            }), encoding="utf-8")
            with patch("services.modal_runtime.spawn_hydrate_official_extensions") as spawn:
                listed = list_extension_catalog(root)
            by_id = {item["id"]: item for item in listed}
            self.assertEqual(by_id["hunyuan3d-mini"]["name"], "From Volume")
            self.assertEqual(set(by_id), {"hunyuan3d-mini", "triposg", "trellis-2"})
            spawn.assert_called_once()
