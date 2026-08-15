import asyncio
import subprocess
import sys
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.extension_catalog import list_model_extension_manifests
from services.extension_install import (
    clear_incomplete,
    download_github_tarball,
    extract_extension,
    parse_github_repo,
    remove_extension,
)
from services.modal_runtime import commit_volume, spawn_extension_setup

router = APIRouter(tags=["extensions"])


class GithubInstallRequest(BaseModel):
    url: str


class ExtensionIdRequest(BaseModel):
    id: str


@router.get("/catalog")
async def extension_catalog():
    """Raw model-extension manifests on this backend (Modal Volume or local dir)."""
    from services.generator_registry import EXTENSIONS_DIR
    return {"extensions": list_model_extension_manifests(EXTENSIONS_DIR)}


@router.post("/install-from-github")
async def install_from_github(body: GithubInstallRequest):
    from services.generator_registry import EXTENSIONS_DIR, generator_registry

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


@router.post("/uninstall")
async def uninstall_extension(body: ExtensionIdRequest):
    from services.generator_registry import EXTENSIONS_DIR, generator_registry

    try:
        remove_extension(EXTENSIONS_DIR, body.id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    generator_registry.reload()
    commit_volume("modly-extensions")
    return {"success": True}


@router.post("/repair")
async def repair_extension(body: ExtensionIdRequest):
    if spawn_extension_setup(body.id):
        return {"success": True, "queued": True}
    result = await setup_extension(body.id)
    commit_volume("modly-extensions")
    return {"success": True, **result}


@router.post("/reload")
async def reload_extensions():
    """
    Re-scans the extensions/ folder and reloads the registry without restarting FastAPI.
    Unloads all currently loaded generators before reloading.
    """
    from services.generator_registry import generator_registry
    generator_registry.reload()
    return {
        "reloaded": True,
        "models":   list(generator_registry._generators.keys()),
        "errors":   generator_registry.load_errors(),
    }


@router.post("/setup/{ext_id}")
async def setup_extension(ext_id: str):
    """
    Creates the isolated venv for an extension by running its setup.py.
    Called automatically after installing an extension from GitHub.
    Runs setup.py with Modly's embedded Python and the detected GPU SM.
    """
    from services.generator_registry import EXTENSIONS_DIR

    if EXTENSIONS_DIR is None or not EXTENSIONS_DIR.exists():
        raise HTTPException(400, "EXTENSIONS_DIR not configured")

    ext_dir  = EXTENSIONS_DIR / ext_id
    setup_py = ext_dir / "setup.py"

    if not ext_dir.exists():
        raise HTTPException(404, f"Extension '{ext_id}' not found in {EXTENSIONS_DIR}")
    if not setup_py.exists():
        # No setup.py → legacy extension, nothing to do
        return {"status": "skipped", "reason": "no setup.py"}

    # Detect GPU compute capability
    gpu_sm = _detect_gpu_sm()

    # Run setup.py using Modly's embedded Python (sys.executable)
    loop   = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None,
        lambda: subprocess.run(
            [sys.executable, str(setup_py), sys.executable, str(ext_dir), str(gpu_sm)],
            capture_output=True,
            text=True,
        )
    )

    if result.returncode != 0:
        raise HTTPException(500, f"setup.py failed:\n{result.stderr}")

    return {
        "status": "ok",
        "gpu_sm": gpu_sm,
        "output": result.stdout,
    }


@router.get("/errors")
async def extension_errors():
    """Returns extension loading errors (invalid manifest, failed import, etc.)."""
    from services.generator_registry import generator_registry
    return generator_registry.load_errors()


def _detect_gpu_sm() -> int:
    """Returns GPU compute capability as integer (e.g. 86 for SM 8.6), or 0 if no GPU."""
    try:
        import torch
        if torch.cuda.is_available():
            major, minor = torch.cuda.get_device_capability(0)
            return major * 10 + minor
    except Exception:
        pass
    return 0
