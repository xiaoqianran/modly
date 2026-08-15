"""Scale-to-zero defaults for the Modal overlay.

Imported by `modal/app.py` and unit tests. This module must not import
`modal` so tests stay cheap and the laptop CLI extra is not required.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping

# Same rule as modal-ashleykza-comfyui: a GPU tuple is a silent fallback.
# Default is L40S only. A100 / H100 / RTX-PRO-6000 must be explicit.
DEFAULT_GPU = ("L40S",)
DEFAULT_CPU_SCALEDOWN = 8
# Desktop use: look at the mesh, tweak, Generate again. 5s (ComfyUI copy)
# makes every retry a Hunyuan reload. 90s catches that loop (~$0.05 L40S)
# and still goes to zero when the user walks away. Cancel/timeout drop faster.
DEFAULT_GPU_SCALEDOWN = 90
DEFAULT_GPU_DROP_WINDOW = 2
# Hung generate used to sit on L40S for 3600s. 20 min is enough for Hunyuan.
DEFAULT_GPU_TIMEOUT = 20 * 60


def parse_gpu(raw: str) -> tuple[str, ...]:
    gpu = tuple(item.strip() for item in raw.split(",") if item.strip())
    return gpu or DEFAULT_GPU


def env_int(
    environ: Mapping[str, str],
    name: str,
    default: int,
    *,
    minimum: int,
    maximum: int,
) -> int:
    raw = environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {raw!r}.") from exc
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}, got {value}.")
    return value


def env_bool(environ: Mapping[str, str], name: str, default: bool) -> bool:
    raw = environ.get(name, "").strip().lower()
    if not raw:
        return default
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean value, got {raw!r}.")


def idle_release_kwargs(scaledown_window: int) -> dict[str, int]:
    """Containers go to zero when idle. `modal serve` still bills until stopped."""
    return {
        "scaledown_window": scaledown_window,
        "min_containers": 0,
        "buffer_containers": 0,
    }


@dataclass(frozen=True)
class ModalIdleSettings:
    gpu: tuple[str, ...]
    cpu_scaledown_window: int
    gpu_scaledown_window: int
    gpu_timeout_seconds: int
    memory_snapshot: bool
    gpu_snapshot: bool

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> "ModalIdleSettings":
        env = os.environ if environ is None else environ
        memory_snapshot = env_bool(env, "MODLY_MEMORY_SNAPSHOT", True)
        gpu_snapshot = env_bool(env, "MODLY_GPU_SNAPSHOT", False) and memory_snapshot
        return cls(
            gpu=parse_gpu(env.get("MODLY_GPU", "")),
            cpu_scaledown_window=env_int(
                env,
                "MODLY_CPU_SCALEDOWN",
                DEFAULT_CPU_SCALEDOWN,
                minimum=2,
                maximum=20 * 60,
            ),
            gpu_scaledown_window=env_int(
                env,
                "MODLY_GPU_SCALEDOWN",
                DEFAULT_GPU_SCALEDOWN,
                minimum=2,
                maximum=20 * 60,
            ),
            gpu_timeout_seconds=env_int(
                env,
                "MODLY_GPU_TIMEOUT",
                DEFAULT_GPU_TIMEOUT,
                minimum=60,
                maximum=60 * 60,
            ),
            memory_snapshot=memory_snapshot,
            gpu_snapshot=gpu_snapshot,
        )

    def cpu_function_kwargs(self) -> dict:
        return idle_release_kwargs(self.cpu_scaledown_window)

    def gpu_function_kwargs(self) -> dict:
        """One-shot GPU functions (setup.py bake). Not an interactive session."""
        return {
            "gpu": list(self.gpu),
            **idle_release_kwargs(self.gpu_scaledown_window),
            "single_use_containers": True,
        }

    def gpu_cls_kwargs(self) -> dict:
        # Keep the class container + loaded weights for a short retry window.
        # Do NOT set single_use_containers: that reloads Hunyuan on every click.
        kwargs: dict = {
            "gpu": list(self.gpu),
            **idle_release_kwargs(self.gpu_scaledown_window),
            "enable_memory_snapshot": self.memory_snapshot,
        }
        if self.gpu_snapshot:
            kwargs["experimental_options"] = {"enable_gpu_snapshot": True}
        return kwargs
