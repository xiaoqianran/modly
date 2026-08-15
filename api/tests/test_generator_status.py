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
