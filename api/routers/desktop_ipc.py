"""Generic IPC forwarder for unknown future Electron channels.

Electron's intercept posts here when classifyIpcChannel returns
forward-unknown. Known aliases are handled; anything else returns
`{"fallback": true}` so the laptop can still run the original handler.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(tags=["desktop-ipc"])


class DesktopIpcRequest(BaseModel):
    channel: str
    args: list[Any] = []


@router.post("/desktop/ipc")
async def desktop_ipc(body: DesktopIpcRequest):
    channel = body.channel
    args = body.args

    if channel == "model:isDownloaded":
        from services.generator_registry import generator_registry

        model_id = str(args[0]) if args else ""
        try:
            return generator_registry.get_generator(model_id).is_downloaded()
        except Exception:
            return False

    if channel == "model:listDownloaded":
        from services.generator_registry import generator_registry

        return [
            {"id": row["id"], "name": row.get("name", row["id"]), "size_gb": 0}
            for row in generator_registry.all_status()
            if row.get("downloaded")
        ]

    if channel.startswith("model:") or channel.startswith("extensions:"):
        return {
            "fallback": True,
            "detail": f"No Modal adapter for {channel} yet. Add one here; Electron does not need a patch.",
        }

    return {"fallback": True, "detail": f"Unhandled channel {channel}"}
