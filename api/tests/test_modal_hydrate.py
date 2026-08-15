import json
import tempfile
import unittest
from pathlib import Path

from services.modal_hydrate import hf_targets_from_extensions


class HfTargetsTests(unittest.TestCase):
    def test_reads_node_repos_even_if_incomplete(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            ext = root / "hunyuan"
            ext.mkdir()
            (ext / ".modly-incomplete").write_text("installing", encoding="utf-8")
            (ext / "manifest.json").write_text(
                json.dumps(
                    {
                        "id": "hunyuan-mini",
                        "type": "model",
                        "nodes": [
                            {
                                "id": "mini",
                                "hf_repo": "tencent/Hunyuan3D-2mini",
                                "hf_skip_prefixes": ["*.onnx"],
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            (root / "process-ext").mkdir()
            (root / "process-ext" / "manifest.json").write_text(
                json.dumps({"id": "smoother", "type": "process"}),
                encoding="utf-8",
            )
            models = root / "models"
            targets = hf_targets_from_extensions(root, models)
            self.assertEqual(len(targets), 1)
            self.assertEqual(targets[0]["model_id"], "hunyuan-mini/mini")
            self.assertEqual(targets[0]["hf_repo"], "tencent/Hunyuan3D-2mini")
            self.assertEqual(targets[0]["hf_skip_prefixes"], ["*.onnx"])
            self.assertTrue(targets[0]["dest"].endswith("hunyuan-mini/mini"))
