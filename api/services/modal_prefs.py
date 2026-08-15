"""User-overridable Modal GPU prefs. No FastAPI, Electron, or Generate.

Linger can change at runtime (`update_autoscaler`). The preferred GPU SKU
is stored for the next `modal deploy` — Modal bakes `gpu=` onto the class.
"""

from __future__ import annotations

import os
from typing import Any, Mapping, Optional

from services.modal_idle import (
    DEFAULT_GPU,
    DEFAULT_GPU_SCALEDOWN,
    ModalIdleSettings,
)

MIN_LINGER_SECONDS = 2
MAX_LINGER_SECONDS = 20 * 60
DEFAULT_LINGER_SECONDS = DEFAULT_GPU_SCALEDOWN
DEFAULT_PREFERRED_GPU = DEFAULT_GPU[0]

ALLOWED_GPUS = (
    "L40S",
    "L4",
    "A10",
    "A10G",
    "A100",
    "A100-80GB",
    "H100",
    "H200",
    "T4",
    "B200",
    "RTX-PRO-6000",
)

SETTINGS_DICT_NAME = "modly-settings"
_PREFS_KEY = "prefs"

_loaded = False
_linger_override: Optional[int] = None
_gpu_override: Optional[str] = None


def reset_modal_prefs_for_tests() -> None:
    global _loaded, _linger_override, _gpu_override
    _loaded = False
    _linger_override = None
    _gpu_override = None


def clamp_linger_seconds(value: Any) -> int:
    if value is None or value == "":
        return DEFAULT_LINGER_SECONDS
    try:
        seconds = int(round(float(value)))
    except (TypeError, ValueError):
        return DEFAULT_LINGER_SECONDS
    return max(MIN_LINGER_SECONDS, min(MAX_LINGER_SECONDS, seconds))


def normalize_gpu(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return DEFAULT_PREFERRED_GPU
    for gpu in ALLOWED_GPUS:
        if gpu.lower() == raw.lower():
            return gpu
    return DEFAULT_PREFERRED_GPU


def deployed_gpu(environ: Mapping[str, str] | None = None) -> str:
    idle = ModalIdleSettings.from_env(environ)
    return idle.gpu[0] if idle.gpu else DEFAULT_PREFERRED_GPU


def _ensure_loaded() -> None:
    global _loaded
    if _loaded:
        return
    _loaded = True
    load_modal_prefs()


def linger_seconds(environ: Mapping[str, str] | None = None) -> int:
    _ensure_loaded()
    if _linger_override is not None:
        return clamp_linger_seconds(_linger_override)
    env = os.environ if environ is None else environ
    raw = env.get("MODLY_GPU_SCALEDOWN", "").strip()
    if raw:
        return clamp_linger_seconds(raw)
    return DEFAULT_LINGER_SECONDS


def preferred_gpu(environ: Mapping[str, str] | None = None) -> str:
    _ensure_loaded()
    if _gpu_override is not None:
        return normalize_gpu(_gpu_override)
    env = os.environ if environ is None else environ
    raw = env.get("MODLY_GPU", "").strip()
    if raw:
        return normalize_gpu(raw.split(",")[0])
    return DEFAULT_PREFERRED_GPU


def public_modal_prefs(environ: Mapping[str, str] | None = None) -> dict[str, Any]:
    gpu = preferred_gpu(environ)
    live = deployed_gpu(environ)
    return {
        "lingerSeconds": linger_seconds(environ),
        "gpu": gpu,
        "deployedGpu": live,
        "allowedGpus": list(ALLOWED_GPUS),
        "minLingerSeconds": MIN_LINGER_SECONDS,
        "maxLingerSeconds": MAX_LINGER_SECONDS,
        "lingerAppliesImmediately": True,
        "gpuAppliesOnDeploy": True,
        "gpuMatchesDeploy": gpu == live,
    }


def set_modal_prefs(
    *,
    linger_seconds: Any = None,
    gpu: Any = None,
    persist: bool = True,
) -> dict[str, Any]:
    global _loaded, _linger_override, _gpu_override
    _loaded = True
    if linger_seconds is not None:
        _linger_override = clamp_linger_seconds(linger_seconds)
    if gpu is not None:
        _gpu_override = normalize_gpu(gpu)
    if persist:
        persist_modal_prefs()
    return public_modal_prefs()


def persist_modal_prefs() -> bool:
    if os.environ.get("MODLY_RUNTIME", "") != "modal":
        return False
    try:
        import modal

        store = modal.Dict.from_name(SETTINGS_DICT_NAME, create_if_missing=True)
        store[_PREFS_KEY] = {
            "lingerSeconds": linger_seconds(),
            "gpu": preferred_gpu(),
        }
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[modal] persist prefs failed: {exc}")
        return False


def load_modal_prefs() -> bool:
    global _linger_override, _gpu_override
    if os.environ.get("MODLY_RUNTIME", "") != "modal":
        return False
    try:
        import modal

        store = modal.Dict.from_name(SETTINGS_DICT_NAME, create_if_missing=True)
        raw = store.get(_PREFS_KEY)
        if not isinstance(raw, dict):
            return False
        if "lingerSeconds" in raw or "linger_seconds" in raw:
            _linger_override = clamp_linger_seconds(
                raw.get("lingerSeconds", raw.get("linger_seconds"))
            )
        if "gpu" in raw:
            _gpu_override = normalize_gpu(raw.get("gpu"))
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[modal] load prefs failed: {exc}")
        return False
