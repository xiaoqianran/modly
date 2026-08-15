"""Mount overlay HTTP on the upstream FastAPI app. One call from main.py."""

from __future__ import annotations

import os

from fastapi.responses import JSONResponse


async def optional_bearer(request, call_next):
    token = os.environ.get("MODLY_API_TOKEN", "").strip()
    if not token:
        return await call_next(request)
    path = request.url.path
    if path in ("/health", "/docs", "/openapi.json", "/redoc"):
        return await call_next(request)
    auth = request.headers.get("authorization", "")
    if auth != f"Bearer {token}":
        return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    return await call_next(request)


def mount_overlay(app) -> None:
    from routers import desktop_ipc, runs
    from routers.overlay_http import router as overlay_router

    app.include_router(desktop_ipc.router)
    app.include_router(runs.router)
    app.include_router(overlay_router)
    app.middleware("http")(optional_bearer)
