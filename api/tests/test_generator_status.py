import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from services.generator_registry import GeneratorRegistry


class _StubGen:
    DISPLAY_NAME = "Hunyuan"
    VRAM_GB = 6

    def is_downloaded(self) -> bool:
        return True

    def is_loaded(self) -> bool:
        return False


class AllStatusDiskMergeTests(unittest.TestCase):
    def test_includes_weights_when_generator_failed_to_import(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            ext = root / "trellis-2"
            ext.mkdir()
            (ext / "manifest.json").write_text(
                json.dumps(
                    {
                        "id": "trellis-2",
                        "type": "model",
                        "nodes": [
                            {
                                "id": "trellis-2",
                                "hf_repo": "microsoft/TRELLIS.2-4B",
                                "download_check": "pipeline.json",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            models = root / "models"
            dest = models / "trellis-2" / "trellis-2"
            dest.mkdir(parents=True)
            (dest / "pipeline.json").write_text("{}", encoding="utf-8")

            registry = GeneratorRegistry()
            registry._generators = {"hunyuan3d-mini/generate": _StubGen()}
            registry._manifests = {"hunyuan3d-mini/generate": {"name": "Hunyuan3D 2 Mini"}}
            registry._active_id = "hunyuan3d-mini/generate"

            with patch("services.generator_registry.EXTENSIONS_DIR", root), patch(
                "services.generator_registry.MODELS_DIR", models
            ):
                rows = {item["id"]: item for item in registry.all_status()}

            self.assertTrue(rows["hunyuan3d-mini/generate"]["downloaded"])
            self.assertTrue(rows["trellis-2/trellis-2"]["downloaded"])
            self.assertFalse(rows["trellis-2/trellis-2"]["loaded"])


def _write_extension(
    root: Path,
    *,
    ext_id: str,
    node_id: str,
    generator_py: str,
    extra_files: dict[str, str] | None = None,
    dirs: tuple[str, ...] = (),
) -> Path:
    ext = root / ext_id
    ext.mkdir()
    (ext / "manifest.json").write_text(
        json.dumps(
            {
                "id": ext_id,
                "type": "model",
                "generator_class": "DummyGenerator",
                "nodes": [
                    {
                        "id": node_id,
                        "name": ext_id,
                        "hf_repo": "example/weights",
                        "download_check": "pipeline.json",
                        "params_schema": [],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    (ext / "generator.py").write_text(generator_py, encoding="utf-8")
    for name in dirs:
        (ext / name).mkdir()
    for rel, text in (extra_files or {}).items():
        (ext / rel).write_text(text, encoding="utf-8")
    return ext


class StatusOnlyDiscoverTests(unittest.TestCase):
    def test_vendor_without_venv_is_known_but_not_runnable(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            _write_extension(
                root,
                ext_id="trellis-2",
                node_id="trellis-2",
                generator_py="from PIL import Image\n\nclass DummyGenerator:\n    pass\n",
                extra_files={"build_vendor.py": "# vendor builder\n"},
                dirs=("vendor",),
            )
            models = root / "models"
            dest = models / "trellis-2" / "trellis-2"
            dest.mkdir(parents=True)
            (dest / "pipeline.json").write_text("{}", encoding="utf-8")

            with patch("services.generator_registry.EXTENSIONS_DIR", root), patch(
                "services.generator_registry.MODELS_DIR", models
            ):
                registry = GeneratorRegistry()
                registry.initialize()

            model_id = "trellis-2/trellis-2"
            self.assertIn(model_id, registry._generators)
            self.assertTrue(registry._generators[model_id].is_downloaded())
            self.assertEqual(registry.params_schema(model_id), [])
            with self.assertRaises(ValueError) as ctx:
                registry.get_generator(model_id)
            self.assertIn("venv", str(ctx.exception).lower())
            self.assertNotIn("Unknown model ID", str(ctx.exception))
            rows = {item["id"]: item for item in registry.all_status()}
            self.assertTrue(rows[model_id]["downloaded"])

    def test_direct_import_failure_keeps_status_row(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            _write_extension(
                root,
                ext_id="broken",
                node_id="gen",
                generator_py="raise ImportError(\"No module named 'PIL'\")\n",
            )
            models = root / "models"
            dest = models / "broken" / "gen"
            dest.mkdir(parents=True)
            (dest / "pipeline.json").write_text("{}", encoding="utf-8")

            with patch("services.generator_registry.EXTENSIONS_DIR", root), patch(
                "services.generator_registry.MODELS_DIR", models
            ):
                registry = GeneratorRegistry()
                registry.initialize()

            model_id = "broken/gen"
            self.assertIn(model_id, registry._generators)
            with self.assertRaises(ValueError) as ctx:
                registry.get_generator(model_id)
            self.assertIn("PIL", str(ctx.exception))
            self.assertTrue(registry._generators[model_id].is_downloaded())
