import json
import tempfile
import unittest
from pathlib import Path

from services.modal_hydrate import (
    dest_has_weights,
    disk_status_rows,
    download_hf_target,
    hf_targets_from_extensions,
    model_is_downloaded,
    target_for_model_id,
)


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
            self.assertEqual(targets[0]["download_check"], "")
            self.assertEqual(target_for_model_id("hunyuan-mini/mini", root, models)["hf_repo"], "tencent/Hunyuan3D-2mini")
            self.assertIsNone(target_for_model_id("missing/x", root, models))

    def test_download_skips_when_dest_has_files(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            dest = Path(raw) / "weights"
            dest.mkdir()
            (dest / "model.safetensors").write_text("x", encoding="utf-8")
            self.assertTrue(dest_has_weights(dest))
            self.assertEqual(
                download_hf_target({"dest": str(dest), "hf_repo": "x/y", "hf_skip_prefixes": []}),
                "skipped",
            )

    def test_disk_status_sees_trellis_weights_without_importing_generator(self) -> None:
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
            rows = disk_status_rows(root, models)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["id"], "trellis-2/trellis-2")
            self.assertTrue(rows[0]["downloaded"])
            self.assertTrue(model_is_downloaded("trellis-2/trellis-2", root, models))
            self.assertFalse(model_is_downloaded("missing/x", root, models))
            self.assertEqual(disk_status_rows(None, models), [])
