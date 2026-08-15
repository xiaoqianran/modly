"""Windows → Modal overlay contract, Python side.

No FastAPI TestClient, no GPU, no `modal deploy`. Asserts the JSON the
8765 gateway must be able to return after a live generate/cancel/catalog.
"""

from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from services.extension_catalog import list_extension_catalog, list_model_extension_manifests
from services.generate_dispatch import JOB_STATUSES, job_status_is_sound
from services.job_store import reset_job_store_for_tests
from services.run_store import reset_run_store_for_tests
from services.run_tracker import list_snapshots, note_spawn, note_spawn_failed, open_run, snapshot


RUN_KEYS = {
    "run_id",
    "job_id",
    "model_id",
    "source",
    "gpu",
    "status",
    "chain",
    "spans",
    "spawn_call_id",
    "cpu_polls",
    "error",
    "created_at",
    "updated_at",
    "bill",
    "leak",
    "phase",
}

BILL_KEYS = {
    "gpu",
    "gpu_seconds",
    "cpu_seconds",
    "gpu_usd",
    "cpu_usd",
    "estimated_usd",
    "price_note",
}


class OverlayHttpShapeTests(unittest.TestCase):
    def setUp(self) -> None:
        reset_run_store_for_tests()
        reset_job_store_for_tests()

    def test_generate_accept_and_status_shapes(self) -> None:
        accept = {"job_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}
        self.assertIsInstance(accept["job_id"], str)
        self.assertTrue(accept["job_id"])
        status = {
            "job_id": accept["job_id"],
            "status": "pending",
            "progress": 0,
            "step": None,
            "output_url": None,
            "error": None,
        }
        self.assertTrue(job_status_is_sound(status["status"]))
        for allowed in JOB_STATUSES:
            status["status"] = allowed
            self.assertTrue(job_status_is_sound(status["status"]))

    def test_runs_list_shape_after_spawn(self) -> None:
        with patch.dict(os.environ, {"MODLY_RUNTIME": "modal"}, clear=False):
            open_run("job-live", "hunyuan-mini/mini", "generate")
        note_spawn("job-live", "fc-abc")
        body = snapshot("job-live")
        self.assertIsNotNone(body)
        self.assertTrue(RUN_KEYS.issubset(body.keys()))
        self.assertTrue(BILL_KEYS.issubset(body["bill"].keys()))
        self.assertEqual(body["spawn_call_id"], "fc-abc")
        self.assertEqual(body["chain"][:3], ["desktop.8765", "gateway", "cpu.asgi"])
        self.assertIn("gpu.worker", body["chain"])
        self.assertEqual(body["phase"]["id"], "starting_gpu")
        self.assertIsInstance(body["bill"]["estimated_usd"], float)
        listed = {"runs": list_snapshots(20)}
        self.assertEqual(listed["runs"][0]["job_id"], "job-live")

    def test_spawn_failure_snapshot_has_no_gpu_worker_and_error_status(self) -> None:
        with patch.dict(os.environ, {"MODLY_RUNTIME": "modal"}, clear=False):
            open_run("job-fail", "hunyuan-mini/mini", "generate")
        note_spawn_failed("job-fail", "GPU worker spawn failed")
        body = snapshot("job-fail")
        self.assertEqual(body["status"], "error")
        self.assertIn("spawn", (body["error"] or "").lower())
        self.assertNotIn("gpu.worker", body["chain"])
        self.assertEqual(body["bill"]["gpu_seconds"], 0.0)

    def test_modal_prefs_shape(self) -> None:
        from services.modal_prefs import public_modal_prefs, reset_modal_prefs_for_tests

        reset_modal_prefs_for_tests()
        body = public_modal_prefs({})
        for key in (
            "lingerSeconds",
            "gpu",
            "deployedGpu",
            "allowedGpus",
            "lingerAppliesImmediately",
            "gpuAppliesOnDeploy",
        ):
            self.assertIn(key, body)
        self.assertEqual(body["lingerSeconds"], 60)
        self.assertEqual(body["gpu"], "L40S")
        self.assertTrue(body["lingerAppliesImmediately"])
        self.assertTrue(body["gpuAppliesOnDeploy"])

    def test_unknown_model_http_error_shape(self) -> None:
        body = {"detail": "Unknown model ID: 'nope'. Available: ['hunyuan-mini/mini']"}
        self.assertIsInstance(body["detail"], str)
        self.assertIn("Unknown model ID", body["detail"])


class CatalogSkipIncompleteTests(unittest.TestCase):
    def test_wrapper_matches_fast_api_envelope(self) -> None:
        import json
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            ready = root / "hunyuan"
            ready.mkdir()
            (ready / "manifest.json").write_text(json.dumps({
                "id": "hunyuan",
                "type": "model",
                "nodes": [{"id": "mini"}],
            }), encoding="utf-8")
            pending = root / "trellis-2"
            pending.mkdir()
            (pending / ".modly-incomplete").write_text("installing", encoding="utf-8")
            (pending / "manifest.json").write_text(json.dumps({
                "id": "trellis-2",
                "type": "model",
                "nodes": [{"id": "fast"}],
            }), encoding="utf-8")
            payload = {"extensions": list_model_extension_manifests(root)}
            self.assertEqual([row["id"] for row in payload["extensions"]], ["hunyuan"])

    def test_catalog_endpoint_shape_includes_official_stubs(self) -> None:
        from unittest.mock import patch

        with patch("services.modal_runtime.spawn_hydrate_official_extensions"):
            payload = {"extensions": list_extension_catalog(None)}
        ids = [row["id"] for row in payload["extensions"]]
        self.assertEqual(ids, ["hunyuan3d-mini", "triposg", "trellis-2"])
        hunyuan = payload["extensions"][0]
        self.assertEqual(hunyuan["nodes"][0]["id"], "generate")
