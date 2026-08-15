"""Job.step strings the Windows HUD already polls. Overlay-only.

GpuGenerator and the CPU spawn hook write these so Generate does not need
a Modal branch — `useGeneration` already copies `step` from /generate/status.
"""

from __future__ import annotations

from typing import Any

STEP_STARTING_GPU = "Starting GPU worker…"
STEP_DOWNLOADING = "Downloading model weights"
STEP_STAGING = "Preparing extension runtime…"
STEP_LOADING = "Loading model"
STEP_GENERATING = "Generating 3D mesh…"
STEP_COMMITTING = "Saving output"


def model_weights_ready(registry: Any, model_id: str) -> bool:
    """True when the active generator already has weights on the Volume."""
    try:
        return bool(registry.get_generator(model_id).is_downloaded())
    except Exception:  # noqa: BLE001
        return False
