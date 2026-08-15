from __future__ import annotations

import unittest
from pathlib import Path

from services.gpu_job_steps import STEP_DOWNLOADING, STEP_STARTING_GPU, model_weights_ready
from services.run_ledger import RunRecord

MODAL_APP = Path(__file__).resolve().parents[2] / "modal" / "app.py"


class FakeGen:
    def __init__(self, ready: bool) -> None:
        self._ready = ready

    def is_downloaded(self) -> bool:
        return self._ready


class FakeReg:
    def __init__(self, gen: FakeGen | None = None, err: Exception | None = None) -> None:
        self.gen = gen
        self.err = err

    def get_generator(self, model_id: str) -> FakeGen:
        if self.err:
            raise self.err
        assert self.gen is not None
        return self.gen


class WeightsReadyTests(unittest.TestCase):
    def test_ready_missing_and_unknown(self) -> None:
        self.assertTrue(model_weights_ready(FakeReg(FakeGen(True)), "m"))
        self.assertFalse(model_weights_ready(FakeReg(FakeGen(False)), "m"))
        self.assertFalse(model_weights_ready(FakeReg(err=ValueError("unknown")), "m"))
        self.assertTrue(STEP_DOWNLOADING.lower().startswith("download"))
        self.assertIn("GPU", STEP_STARTING_GPU)
        src = MODAL_APP.read_text(encoding="utf-8")
        self.assertIn("prepare_and_spawn_gpu", src)
        self.assertIn("Download runs on CPU only", src)
        self.assertIn("stage_generator_venv", src)
        self.assertIn("STEP_GENERATING", src)
        self.assertIn("model_weights_ready", src)
        self.assertNotIn("STEP_DOWNLOADING", src)
        load_at = src.find("get_active()")
        first_models_commit = src.find("models_vol.commit()", load_at)
        generate_at = src.find("gen.generate(", load_at)
        self.assertGreater(load_at, 0)
        self.assertGreater(first_models_commit, load_at)
        self.assertGreater(generate_at, first_models_commit)


class PhaseTests(unittest.TestCase):
    def test_pending_without_spawn_is_accepted(self) -> None:
        rec = RunRecord(run_id="j", job_id="j", model_id="m", source="g", gpu="L40S", status="pending")
        rec.open_span("cpu.accept", 1.0)
        self.assertEqual(rec.phase()["id"], "accepted")

    def test_pending_with_spawn_is_starting_gpu(self) -> None:
        rec = RunRecord(run_id="j", job_id="j", model_id="m", source="g", gpu="L40S", status="pending")
        rec.spawn_call_id = "fc-1"
        rec.open_span("cpu.accept", 1.0)
        rec.open_span("cpu.spawn_gpu", 2.0, "fc-1")
        self.assertEqual(rec.phase()["id"], "starting_gpu")

    def test_downloading_is_not_classified_as_loading(self) -> None:
        rec = RunRecord(run_id="j", job_id="j", model_id="m", source="g", gpu="L40S", status="running")
        rec.open_span("gpu.generate", 1.0, "Loading model")
        rec.note("gpu.step", 2.0, "Downloading model weights")
        self.assertEqual(rec.phase()["id"], "downloading_weights")

    def test_loading_generating_commit_terminal(self) -> None:
        loading = RunRecord(run_id="j", job_id="j", model_id="m", source="g", gpu="L40S", status="running")
        loading.open_span("gpu.generate", 1.0, "Loading model")
        self.assertEqual(loading.phase()["id"], "loading_model")

        gen = RunRecord(run_id="j", job_id="j", model_id="m", source="g", gpu="L40S", status="running")
        gen.open_span("gpu.generate", 1.0, "Loading model")
        gen.note("gpu.step", 2.0, "Generating 3D mesh…")
        self.assertEqual(gen.phase()["id"], "generating")

        commit = RunRecord(run_id="j", job_id="j", model_id="m", source="g", gpu="L40S", status="running")
        commit.note("gpu.step", 1.0, "Saving output")
        self.assertEqual(commit.phase()["id"], "committing")

        done = RunRecord(run_id="j", job_id="j", model_id="m", source="g", gpu="L40S", status="done")
        self.assertEqual(done.phase()["id"], "done")
        err = RunRecord(run_id="j", job_id="j", model_id="m", source="g", gpu="L40S", status="error")
        self.assertEqual(err.phase()["id"], "error")

    def test_to_dict_includes_phase(self) -> None:
        rec = RunRecord(run_id="j", job_id="j", model_id="m", source="g", gpu="L40S", status="error")
        body = rec.to_dict(now=1.0, cpu_scaledown=0, gpu_scaledown=0, gpu_timeout=100)
        self.assertEqual(body["phase"]["id"], "error")
        self.assertNotIn("phase", rec.payload())
