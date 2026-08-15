"""Overlay-only HTTP. Upstream routers stay free of Modal catalog / prefs / delete."""

from __future__ import annotations

import asyncio
import shutil
import uuid
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, unquote, urlparse

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

from services.extension_catalog import list_extension_catalog
from services.extension_install import (
    clear_incomplete,
    download_github_tarball,
    extract_extension,
    parse_github_repo,
    remove_extension,
)
from services.generator_registry import MODELS_DIR, WORKSPACE_DIR, generator_registry
from services.modal_prefs import public_modal_prefs, set_modal_prefs
from services.modal_runtime import commit_volume, hold_gpu_for_retry, spawn_extension_setup

router = APIRouter(tags=["overlay"])


class ModalPrefsUpdate(BaseModel):
    lingerSeconds: Optional[int] = None
    linger_seconds: Optional[int] = None
    gpu: Optional[str] = None


class GithubInstallRequest(BaseModel):
    url: str


class ExtensionIdRequest(BaseModel):
    id: str


@router.get("/settings/modal")
async def get_modal_prefs():
    return public_modal_prefs()


@router.post("/settings/modal")
async def update_modal_prefs(body: ModalPrefsUpdate):
    linger = body.linger_seconds if body.linger_seconds is not None else body.lingerSeconds
    result = set_modal_prefs(linger_seconds=linger, gpu=body.gpu)
    try:
        hold_gpu_for_retry()
    except Exception:
        pass
    return result


@router.get("/extensions/catalog")
async def extension_catalog():
    from services.generator_registry import EXTENSIONS_DIR

    return {"extensions": list_extension_catalog(EXTENSIONS_DIR)}


@router.post("/extensions/install-from-github")
async def install_from_github(body: GithubInstallRequest):
    from routers.extensions import setup_extension
    from services.generator_registry import EXTENSIONS_DIR

    if EXTENSIONS_DIR is None:
        raise HTTPException(400, "EXTENSIONS_DIR not configured")
    try:
        owner, repo = parse_github_repo(body.url)
        tarball = await asyncio.to_thread(download_github_tarball, owner, repo)
        ext_id = await asyncio.to_thread(
            extract_extension,
            tarball,
            EXTENSIONS_DIR,
            f"https://github.com/{owner}/{repo}",
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"GitHub download failed: {exc}") from exc

    if spawn_extension_setup(ext_id):
        commit_volume("modly-extensions")
        return {"success": True, "extensionId": ext_id, "queued": True}

    await setup_extension(ext_id)
    clear_incomplete(EXTENSIONS_DIR, ext_id)
    generator_registry.reload()
    commit_volume("modly-extensions")
    return {"success": True, "extensionId": ext_id}


@router.post("/extensions/uninstall")
async def uninstall_extension(body: ExtensionIdRequest):
    from services.generator_registry import EXTENSIONS_DIR

    try:
        remove_extension(EXTENSIONS_DIR, body.id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    generator_registry.reload()
    commit_volume("modly-extensions")
    return {"success": True}


@router.post("/extensions/repair")
async def repair_extension(body: ExtensionIdRequest):
    from routers.extensions import setup_extension

    if spawn_extension_setup(body.id):
        return {"success": True, "queued": True}
    result = await setup_extension(body.id)
    commit_volume("modly-extensions")
    return {"success": True, **result}


@router.post("/model/delete/{model_id:path}")
async def delete_model_files(model_id: str):
    dest = (MODELS_DIR / model_id).resolve()
    root = MODELS_DIR.resolve()
    if dest != root and root not in dest.parents:
        raise HTTPException(400, "Invalid model id")
    try:
        gen = generator_registry.get_generator(model_id)
        gen.unload()
    except Exception:
        pass
    if dest.exists() and dest.is_dir():
        shutil.rmtree(dest)
    return {"deleted": True}


@router.post("/optimize/import")
async def import_mesh_upload(file: UploadFile = File(...)):
    filename = file.filename or "mesh.glb"
    ext = Path(filename).suffix.lstrip(".").lower()
    if ext not in ("glb", "obj", "stl", "ply", "splat"):
        raise HTTPException(400, f"Unsupported format: {ext}")

    imports_dir = WORKSPACE_DIR / "Imports"
    imports_dir.mkdir(parents=True, exist_ok=True)
    dest = imports_dir / f"{uuid.uuid4().hex}.{ext}"
    dest.write_bytes(await file.read())

    if ext in ("glb", "splat"):
        rel = dest.relative_to(WORKSPACE_DIR).as_posix()
        return {"url": f"/workspace/{rel}"}

    from routers.optimize import ImportByPathRequest, import_mesh_by_path

    result = await import_mesh_by_path(ImportByPathRequest(path=str(dest)))
    url = result.get("url", "")
    if url.startswith("/workspace/"):
        return result
    if url.startswith("/optimize/serve-file"):
        qs = parse_qs(urlparse(url).query)
        src = Path(unquote(qs.get("path", [""])[0]))
        if src.is_file():
            out = imports_dir / f"{uuid.uuid4().hex}{src.suffix.lower()}"
            shutil.copy2(src, out)
            return {"url": f"/workspace/{out.relative_to(WORKSPACE_DIR).as_posix()}"}
    return result
