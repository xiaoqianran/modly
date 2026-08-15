import os
from fastapi import APIRouter
from pydantic import BaseModel
from pathlib import Path
from typing import Optional

import services.generator_registry as reg_module

router = APIRouter(prefix="/settings", tags=["settings"])


class PathsUpdate(BaseModel):
    models_dir:    Optional[str] = None
    workspace_dir: Optional[str] = None


class TokenUpdate(BaseModel):
    token: str


class ModalPrefsUpdate(BaseModel):
    lingerSeconds: Optional[int] = None
    linger_seconds: Optional[int] = None
    gpu: Optional[str] = None


@router.get("/paths")
async def get_paths():
    return {
        "models_dir":    str(reg_module.MODELS_DIR),
        "workspace_dir": str(reg_module.WORKSPACE_DIR),
    }


@router.post("/paths")
async def update_paths(body: PathsUpdate):
    reg_module.generator_registry.update_paths(
        models_dir    = Path(body.models_dir)    if body.models_dir    else None,
        workspace_dir = Path(body.workspace_dir) if body.workspace_dir else None,
    )
    return {
        "models_dir":    str(reg_module.MODELS_DIR),
        "workspace_dir": str(reg_module.WORKSPACE_DIR),
    }


@router.post("/hf-token")
async def update_hf_token(body: TokenUpdate):
    """
    Update the HuggingFace token in this process's environment so that
    extension subprocesses spawned after this call inherit the new token.
    """
    if body.token:
        os.environ["HUGGING_FACE_HUB_TOKEN"] = body.token
        os.environ["HF_TOKEN"]               = body.token
    else:
        os.environ.pop("HUGGING_FACE_HUB_TOKEN", None)
        os.environ.pop("HF_TOKEN", None)
    return {"ok": True}


@router.get("/modal")
async def get_modal_prefs():
    from services.modal_prefs import public_modal_prefs

    return public_modal_prefs()


@router.post("/modal")
async def update_modal_prefs(body: ModalPrefsUpdate):
    from services.modal_prefs import set_modal_prefs

    linger = body.linger_seconds if body.linger_seconds is not None else body.lingerSeconds
    result = set_modal_prefs(linger_seconds=linger, gpu=body.gpu)
    try:
        from services.modal_runtime import hold_gpu_for_retry

        hold_gpu_for_retry()
    except Exception:
        pass
    return result
