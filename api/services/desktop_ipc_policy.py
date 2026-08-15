"""Classify POST /desktop/ipc without FastAPI or the generator registry.

Electron's intercept posts unknown `model:` / `extensions:` channels here.
Known aliases are handled by the router; everything else returns
`{"fallback": true}` so the laptop still runs the original handler.
"""

from __future__ import annotations

from typing import Any, Literal

DesktopIpcKind = Literal["model-is-downloaded", "model-list-downloaded", "fallback"]


def desktop_ipc_kind(channel: str) -> DesktopIpcKind:
    if channel == "model:isDownloaded":
        return "model-is-downloaded"
    if channel == "model:listDownloaded":
        return "model-list-downloaded"
    return "fallback"


def desktop_ipc_fallback_body(channel: str) -> dict[str, Any]:
    if channel.startswith("model:") or channel.startswith("extensions:"):
        detail = (
            f"No Modal adapter for {channel} yet. "
            "Add one here; Electron does not need a patch."
        )
    else:
        detail = f"Unhandled channel {channel}"
    return {"fallback": True, "detail": detail}


def is_desktop_ipc_fallback(body: object) -> bool:
    return isinstance(body, dict) and body.get("fallback") is True
