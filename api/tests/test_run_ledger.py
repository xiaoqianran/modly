import time
import unittest

from services.job_store import reset_job_store_for_tests
from services.run_ledger import GPU_USD_PER_SEC, RunRecord
from services.run_store import get_run_store, reset_run_store_for_tests
from services.run_tracker import (
    apply_status_watch,
    finish_run,
    gpu_enter,
    list_snapshots,
    mark_cancel,
    note_hydrate,
    note_spawn,
    open_run,
    snapshot,
    touch_poll,
)


class RunRecordTests(unittest.TestCase):
    def test_bill_uses_wall_window_plus_scaledown(self) -> None:
        rec = RunRecord(
            run_id="j1",
            job_id="j1",
            model_id="hunyuan",
            source="generate",
            gpu="L40S",
            created_at=100.0,
        )
        rec.open_span("cpu.accept", 100.0)
        rec.open_span("gpu.generate", 110.0)
        rec.close_span("gpu.generate", 170.0)
        rec.close_span("cpu.accept", 172.0)
        bill = rec.bill(now=200.0, cpu_scaledown=8, gpu_scaledown=5)
        self.assertAlmostEqual(bill.gpu_seconds, 65.0)  # 60s infer + 5s scaledown
        self.assertAlmostEqual(bill.cpu_seconds, 80.0)  # 72s window + 8s
        self.assertAlmostEqual(bill.gpu_usd, 65.0 * GPU_USD_PER_SEC["L40S"])
        self.assertGreater(bill.estimated_usd, bill.gpu_usd)

    def test_overlapping_gpu_spans_do_not_double_count(self) -> None:
        rec = RunRecord(run_id="j", job_id="j", model_id="m", source="g", gpu="L40S")
        rec.open_span("gpu.generate", 0.0)
        rec.note("gpu.step", 10.0, "load")
        rec.close_span("gpu.generate", 30.0)
        bill = rec.bill(now=30.0, cpu_scaledown=0, gpu_scaledown=0)
        self.assertAlmostEqual(bill.gpu_seconds, 30.0)

    def test_close_without_open_does_not_invent_a_span(self) -> None:
        rec = RunRecord(run_id="j", job_id="j", model_id="m", source="g", gpu="L40S")
        rec.close_span("gpu.generate", 50.0)
        self.assertEqual(rec.spans, [])
        bill = rec.bill(now=50.0, cpu_scaledown=0, gpu_scaledown=5)
        self.assertAlmostEqual(bill.gpu_seconds, 0.0)

    def test_double_close_does_not_stretch_window(self) -> None:
        rec = RunRecord(run_id="j", job_id="j", model_id="m", source="g", gpu="L40S")
        rec.open_span("gpu.generate", 10.0)
        rec.close_span("gpu.generate", 20.0)
        rec.close_span("gpu.generate", 999.0)
        bill = rec.bill(now=999.0, cpu_scaledown=0, gpu_scaledown=0)
        self.assertAlmostEqual(bill.gpu_seconds, 10.0)

    def test_open_gpu_bill_is_capped_at_timeout(self) -> None:
        rec = RunRecord(
            run_id="j",
            job_id="j",
            model_id="m",
            source="g",
            gpu="L40S",
            status="running",
        )
        rec.open_span("gpu.generate", 0.0)
        bill = rec.bill(now=10_000.0, cpu_scaledown=0, gpu_scaledown=5, gpu_timeout=100)
        self.assertAlmostEqual(bill.gpu_seconds, 105.0)

    def test_local_run_without_gpu_name_does_not_bill_gpu(self) -> None:
        rec = RunRecord(run_id="j", job_id="j", model_id="m", source="g", gpu="")
        rec.open_span("cpu.accept", 0.0)
        rec.close_span("cpu.accept", 10.0)
        rec.close_span("gpu.generate", 10.0)
        bill = rec.bill(now=10.0, cpu_scaledown=0, gpu_scaledown=5)
        self.assertAlmostEqual(bill.gpu_seconds, 0.0)
        self.assertAlmostEqual(bill.gpu_usd, 0.0)

    def test_leak_when_gpu_still_open_after_error(self) -> None:
        rec = RunRecord(
            run_id="j",
            job_id="j",
            model_id="m",
            source="g",
            gpu="L40S",
            status="error",
        )
        rec.open_span("gpu.generate", 1.0)
        leak = rec.leak(now=20.0, gpu_timeout=100)
        self.assertIsNotNone(leak)
        self.assertEqual(leak["kind"], "gpu_span_open_after_terminal")

    def test_timeout_leak_while_running(self) -> None:
        rec = RunRecord(
            run_id="j",
            job_id="j",
            model_id="m",
            source="g",
            gpu="L40S",
            status="running",
        )
        rec.open_span("gpu.generate", 0.0)
        self.assertIsNone(rec.leak(now=10.0, gpu_timeout=100))
        leak = rec.leak(now=200.0, gpu_timeout=100)
        self.assertEqual(leak["kind"], "gpu_over_timeout")

    def test_spawn_hung_when_gpu_never_enters(self) -> None:
        rec = RunRecord(
            run_id="j",
            job_id="j",
            model_id="m",
            source="g",
            gpu="L40S",
            status="pending",
            spawn_call_id="fc-1",
            chain=["desktop.8765", "gpu.worker"],
            created_at=0.0,
        )
        leak = rec.leak(now=2000.0, gpu_timeout=100)
        self.assertEqual(leak["kind"], "spawn_hung")
        cpu_only = RunRecord(
            run_id="c",
            job_id="c",
            model_id="m",
            source="g",
            gpu="L40S",
            status="running",
            spawn_call_id="fc-cpu",
            chain=["desktop.8765", "cpu.hydrate"],
            created_at=0.0,
        )
        self.assertIsNone(cpu_only.leak(now=2000.0, gpu_timeout=100))


class RunTrackerTests(unittest.TestCase):
    def setUp(self) -> None:
        reset_run_store_for_tests()
        reset_job_store_for_tests()

    def test_chain_and_snapshot(self) -> None:
        open_run("job-1", "hunyuan-mini/mini", "generate")
        note_spawn("job-1", "fc-abc")
        gpu_enter("job-1")
        finish_run("job-1", "done")
        body = snapshot("job-1")
        self.assertIsNotNone(body)
        self.assertEqual(body["job_id"], "job-1")
        self.assertEqual(body["status"], "done")
        self.assertEqual(body["spawn_call_id"], "fc-abc")
        self.assertIn("cpu.accept", body["chain"])
        self.assertIn("gpu.generate", [s["name"] for s in body["spans"]])
        self.assertIsNone(body["leak"])
        self.assertIn("estimated_usd", body["bill"])
        self.assertTrue(all(s["t1"] is not None for s in body["spans"] if s["name"].startswith("gpu.")))

    def test_finish_without_gpu_does_not_bill_gpu(self) -> None:
        open_run("local-1", "m", "generate")
        finish_run("local-1", "done")
        body = snapshot("local-1")
        self.assertEqual(body["bill"]["gpu_seconds"], 0.0)
        self.assertEqual(body["bill"]["gpu_usd"], 0.0)
        self.assertNotIn("gpu.generate", [s["name"] for s in body["spans"]])

    def test_polls_extend_one_span(self) -> None:
        open_run("job-2", "m", "generate")
        touch_poll("job-2")
        touch_poll("job-2")
        touch_poll("job-2")
        body = snapshot("job-2")
        polls = [s for s in body["spans"] if s["name"] == "cpu.poll"]
        self.assertEqual(len(polls), 1)
        self.assertEqual(body["cpu_polls"], 3)

    def test_polls_after_done_do_not_keep_counting(self) -> None:
        open_run("job-3", "m", "generate")
        finish_run("job-3", "done")
        touch_poll("job-3")
        touch_poll("job-3")
        body = snapshot("job-3")
        self.assertEqual(body["cpu_polls"], 0)

    def test_cancelled_is_sticky_against_late_done(self) -> None:
        open_run("job-4", "m", "generate")
        note_spawn("job-4", "fc-x")
        gpu_enter("job-4")
        mark_cancel("job-4", "client")
        finish_run("job-4", "done")
        body = snapshot("job-4")
        self.assertEqual(body["status"], "cancelled")

    def test_list_recent(self) -> None:
        open_run("a", "m", "generate")
        open_run("b", "m", "generate")
        ids = [row["job_id"] for row in list_snapshots(10)]
        self.assertEqual(ids[0], "b")
        self.assertIn("a", ids)

    def test_cpu_hydrate_does_not_look_like_spawn_hung(self) -> None:
        open_run("hyd", "triposg/generate", "generate")
        note_hydrate("hyd", "fc-cpu")
        rec = get_run_store().get("hyd")
        assert rec is not None
        rec.created_at = time.time() - 2000
        get_run_store().put(rec)
        body = snapshot("hyd")
        self.assertEqual(body["status"], "running")
        self.assertEqual(body["phase"]["id"], "downloading_weights")
        self.assertIsNone(body["leak"])
        self.assertNotIn("gpu.worker", body["chain"])

    def test_snapshot_heals_over_timeout(self) -> None:
        open_run("hung", "m", "generate")
        note_spawn("hung", "fc-hung")
        gpu_enter("hung")
        rec = get_run_store().get("hung")
        assert rec is not None
        for span in rec.spans:
            if span.name == "gpu.generate":
                span.t0 = time.time() - 2000
        rec.status = "running"
        get_run_store().put(rec)

        body = snapshot("hung")
        self.assertEqual(body["status"], "error")
        self.assertIsNone(body["leak"])
        self.assertTrue(all(s["t1"] is not None for s in body["spans"] if s["name"].startswith("gpu.")))

    def test_status_watch_updates_job_store(self) -> None:
        from services.job_store import get_job_store

        class _Job:
            def __init__(self) -> None:
                self.job_id = "watch"
                self.status = "running"
                self.progress = 1
                self.error = None

        open_run("watch", "m", "generate")
        note_spawn("watch", "fc-w")
        gpu_enter("watch")
        get_job_store().put(_Job())
        rec = get_run_store().get("watch")
        assert rec is not None
        for span in rec.spans:
            if span.name == "gpu.generate":
                span.t0 = time.time() - 2000
        rec.status = "running"
        get_run_store().put(rec)

        self.assertTrue(apply_status_watch("watch"))
        job = get_job_store().get("watch")
        self.assertEqual(job.status, "error")
        self.assertIn("timeout", (job.error or "").lower())
