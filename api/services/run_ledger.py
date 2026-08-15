"""One generate attempt: call chain, wall-clock spans, USD estimate.

Pure data — no I/O, no `modal` import. Persistence is `run_store`.

Modal bills a *container window* (first start → last end) plus the
scaledown seconds, not the sum of overlapping spans. Prices are the
public per-second list (checked Aug 2026). The number is an estimate,
not the invoice.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

# https://modal.com/pricing — per second.
GPU_USD_PER_SEC: dict[str, float] = {
    "T4": 0.000164,
    "L4": 0.000222,
    "A10": 0.000306,
    "L40S": 0.000542,
    "A100": 0.000583,
    "A100-80GB": 0.000694,
    "H100": 0.001097,
    "H200": 0.001261,
    "B200": 0.001736,
    "RTX-PRO-6000": 0.000842,
}

CPU_USD_PER_SEC = 0.000047

TERMINAL = frozenset({"done", "error", "cancelled"})


@dataclass
class Span:
    name: str
    t0: float
    t1: Optional[float] = None
    detail: str = ""

    def duration_s(self, now: Optional[float] = None) -> float:
        end = self.t1 if self.t1 is not None else now
        if end is None:
            return 0.0
        return max(0.0, end - self.t0)

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "t0": self.t0, "t1": self.t1, "detail": self.detail}

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "Span":
        return cls(
            name=str(raw.get("name") or ""),
            t0=float(raw.get("t0") or 0),
            t1=float(raw["t1"]) if raw.get("t1") is not None else None,
            detail=str(raw.get("detail") or ""),
        )


@dataclass
class Bill:
    gpu: str
    gpu_seconds: float
    cpu_seconds: float
    gpu_usd: float
    cpu_usd: float
    estimated_usd: float
    price_note: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "gpu": self.gpu,
            "gpu_seconds": round(self.gpu_seconds, 3),
            "cpu_seconds": round(self.cpu_seconds, 3),
            "gpu_usd": round(self.gpu_usd, 6),
            "cpu_usd": round(self.cpu_usd, 6),
            "estimated_usd": round(self.estimated_usd, 6),
            "price_note": self.price_note,
        }


@dataclass
class RunRecord:
    run_id: str
    job_id: str
    model_id: str
    source: str
    gpu: str
    status: str = "pending"
    chain: list[str] = field(default_factory=list)
    spans: list[Span] = field(default_factory=list)
    spawn_call_id: str = ""
    cpu_polls: int = 0
    error: str = ""
    created_at: float = 0.0
    updated_at: float = 0.0

    def open_span(self, name: str, now: float, detail: str = "") -> None:
        self.spans.append(Span(name=name, t0=now, detail=detail))
        if name not in self.chain:
            self.chain.append(name)
        self.updated_at = now

    def close_span(self, name: str, now: float, detail: str = "") -> None:
        """Close the newest open span of this name. No-op if none is open.

        Must not invent a span: a phantom `gpu.generate` at t=now would
        stretch `_window` from the first GPU start all the way to now.
        """
        for span in reversed(self.spans):
            if span.name == name and span.t1 is None:
                span.t1 = now
                if detail:
                    span.detail = f"{span.detail} {detail}".strip()
                self.updated_at = now
                return

    def note(self, name: str, now: float, detail: str = "") -> None:
        self.spans.append(Span(name=name, t0=now, t1=now, detail=detail))
        if name not in self.chain:
            self.chain.append(name)
        self.updated_at = now

    def gpu_open_since(self) -> Optional[float]:
        for span in self.spans:
            if span.name.startswith("gpu.") and span.t1 is None:
                return span.t0
        return None

    def _window(self, prefix: str, now: float) -> float:
        """Wall time the container was up: first start → last end (or now)."""
        hits = [s for s in self.spans if s.name.startswith(prefix)]
        if not hits:
            return 0.0
        start = min(s.t0 for s in hits)
        end = max((s.t1 if s.t1 is not None else now) for s in hits)
        return max(0.0, end - start)

    def bill(
        self,
        *,
        now: float,
        cpu_scaledown: float,
        gpu_scaledown: float,
        gpu_timeout: float = 0,
    ) -> Bill:
        gpu_s = self._window("gpu.", now)
        cpu_s = self._window("cpu.", now)
        # Modal kills the function at timeout; don't let a stale open span
        # keep growing the estimate every time someone reads /runs.
        if gpu_timeout > 0 and self.gpu_open_since() is not None:
            gpu_s = min(gpu_s, gpu_timeout)
        if gpu_s > 0:
            gpu_s += gpu_scaledown
        if cpu_s > 0:
            cpu_s += cpu_scaledown
        listed = GPU_USD_PER_SEC.get(self.gpu, GPU_USD_PER_SEC["L40S"])
        gpu_usd = gpu_s * listed if self.gpu else 0.0
        cpu_usd = cpu_s * CPU_USD_PER_SEC
        return Bill(
            gpu=self.gpu or "none",
            gpu_seconds=gpu_s,
            cpu_seconds=cpu_s,
            gpu_usd=gpu_usd,
            cpu_usd=cpu_usd,
            estimated_usd=gpu_usd + cpu_usd,
            price_note=(
                f"Modal list {self.gpu or 'L40S'} ${listed}/s + CPU ${CPU_USD_PER_SEC}/s, "
                f"including scaledown cpu={cpu_scaledown}s gpu={gpu_scaledown}s. "
                "Estimate, not the invoice."
            ),
        )

    def leak(
        self,
        *,
        now: float,
        gpu_timeout: float,
    ) -> Optional[dict[str, Any]]:
        opened = self.gpu_open_since()
        if self.status in TERMINAL and opened is not None:
            return {
                "kind": "gpu_span_open_after_terminal",
                "message": "Job already finished but a GPU span is still open — cancel the FunctionCall.",
                "open_since": opened,
            }
        if self.status not in TERMINAL and opened is not None and (now - opened) > gpu_timeout:
            return {
                "kind": "gpu_over_timeout",
                "message": f"GPU span open for {int(now - opened)}s (limit {int(gpu_timeout)}s).",
                "open_since": opened,
            }
        if (
            self.status not in TERMINAL
            and self.spawn_call_id
            and opened is None
            and "gpu.worker" in self.chain
            and (now - self.created_at) > gpu_timeout
        ):
            return {
                "kind": "spawn_hung",
                "message": (
                    f"FunctionCall spawned but GPU never entered for "
                    f"{int(now - self.created_at)}s — cancel it."
                ),
                "open_since": self.created_at,
            }
        return None

    def latest_gpu_step(self) -> str:
        for span in reversed(self.spans):
            if span.name == "gpu.step" and span.detail:
                return span.detail
        for span in reversed(self.spans):
            if span.name == "gpu.generate" and span.detail:
                return span.detail
        return ""

    def gpu_worker_entered(self) -> bool:
        return any(s.name == "gpu.generate" for s in self.spans)

    def phase(self) -> dict[str, str]:
        """Human hop for Settings / curl. Computed on read — not persisted."""
        if self.status == "error":
            return {"id": "error", "label": "Error"}
        if self.status == "cancelled":
            return {"id": "cancelled", "label": "Cancelled"}
        if self.status == "done":
            return {"id": "done", "label": "Done"}

        if any(s.name == "cpu.hydrate" and s.t1 is None for s in self.spans):
            return {"id": "downloading_weights", "label": "Downloading model weights"}

        latest = self.latest_gpu_step()
        low = latest.lower()
        # "downloading" contains "load" — check download first.
        if "download" in low:
            return {"id": "downloading_weights", "label": "Downloading model weights"}
        if "commit" in low or "saving output" in low:
            return {"id": "committing", "label": "Saving output"}
        if "generat" in low or "mesh" in low:
            return {"id": "generating", "label": "Generating 3D mesh"}
        if "load" in low:
            return {"id": "loading_model", "label": "Loading model"}

        if not self.gpu_worker_entered():
            if self.spawn_call_id:
                return {
                    "id": "starting_gpu",
                    "label": "Starting GPU worker (cold start or image pull)",
                }
            return {"id": "accepted", "label": "Accepted on CPU — spawning GPU"}

        if latest:
            return {"id": "running", "label": latest}
        return {"id": "running", "label": "GPU running"}

    def payload(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "job_id": self.job_id,
            "model_id": self.model_id,
            "source": self.source,
            "gpu": self.gpu,
            "status": self.status,
            "chain": list(self.chain),
            "spans": [s.to_dict() for s in self.spans],
            "spawn_call_id": self.spawn_call_id,
            "cpu_polls": self.cpu_polls,
            "error": self.error,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    def to_dict(
        self,
        *,
        now: float,
        cpu_scaledown: float,
        gpu_scaledown: float,
        gpu_timeout: float,
    ) -> dict[str, Any]:
        body = self.payload()
        body["phase"] = self.phase()
        body["bill"] = self.bill(
            now=now,
            cpu_scaledown=cpu_scaledown,
            gpu_scaledown=gpu_scaledown,
            gpu_timeout=gpu_timeout,
        ).to_dict()
        body["leak"] = self.leak(now=now, gpu_timeout=gpu_timeout)
        return body

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "RunRecord":
        spans = [Span.from_dict(s) for s in raw.get("spans") or [] if isinstance(s, dict)]
        return cls(
            run_id=str(raw.get("run_id") or raw.get("job_id") or ""),
            job_id=str(raw.get("job_id") or ""),
            model_id=str(raw.get("model_id") or ""),
            source=str(raw.get("source") or "generate"),
            gpu=str(raw.get("gpu") or ""),
            status=str(raw.get("status") or "pending"),
            chain=[str(x) for x in (raw.get("chain") or [])],
            spans=spans,
            spawn_call_id=str(raw.get("spawn_call_id") or ""),
            cpu_polls=int(raw.get("cpu_polls") or 0),
            error=str(raw.get("error") or ""),
            created_at=float(raw.get("created_at") or 0),
            updated_at=float(raw.get("updated_at") or 0),
        )
