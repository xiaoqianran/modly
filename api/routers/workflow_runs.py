import json
import uuid
from typing import Optional
from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from routers.generation import _run_generation
from schemas.generation import JobStatus
from services.generator_registry import generator_registry
from services.job_store import get_job_store
from services.modal_runtime import spawn_gpu_generation

router = APIRouter(tags=["workflow-runs"])


class WorkflowRunStatus(BaseModel):
    run_id: str
    status: str
    progress: int = 0
    step: Optional[str] = None
    output_url: Optional[str] = None
    error: Optional[str] = None
    scene_candidate: Optional[dict] = None


@router.post("/from-image")
async def create_run_from_image(
    background_tasks: BackgroundTasks,
    image: UploadFile = File(...),
    model_id: str = Form("sf3d"),
    params: str = Form("{}"),
):
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(400, "File must be an image")

    try:
        generator_registry.get_generator(model_id)
    except ValueError as e:
        raise HTTPException(400, str(e))

    generator_registry.switch_model(model_id)

    try:
        model_params = json.loads(params)
    except (json.JSONDecodeError, TypeError):
        model_params = {}

    full_params = {
        "remesh": "quad",
        "enable_texture": False,
        "texture_resolution": 1024,
        **model_params,
    }

    job_id = str(uuid.uuid4())
    image_bytes = await image.read()

    store = get_job_store()
    store.put(JobStatus(job_id=job_id, status="pending", progress=0))
    store.cancel_event(job_id)

    if not spawn_gpu_generation(job_id, model_id, image_bytes, full_params, "Default"):
        background_tasks.add_task(_run_generation, job_id, image_bytes, full_params, "Default")

    return {"run_id": job_id, "status": "pending"}


@router.get("/{run_id}", response_model=WorkflowRunStatus)
async def get_run(run_id: str):
    job = get_job_store().get(run_id)
    if not job:
        raise HTTPException(404, f"Run {run_id} not found")

    scene_candidate = None
    if job.status == "done" and job.output_url:
        scene_candidate = {"workspace_path": job.output_url.removeprefix("/workspace/")}

    return WorkflowRunStatus(
        run_id=job.job_id,
        status=job.status,
        progress=job.progress,
        step=job.step,
        output_url=job.output_url,
        error=job.error,
        scene_candidate=scene_candidate,
    )


@router.post("/{run_id}/cancel")
async def cancel_run(run_id: str):
    store = get_job_store()
    job = store.get(run_id)
    if not job:
        raise HTTPException(404, f"Run {run_id} not found")

    store.mark_cancel(run_id)

    try:
        gen = generator_registry._generators.get(generator_registry._active_id)
        if gen is not None and hasattr(gen, "_proc") and gen._proc and gen._proc.poll() is None:
            gen._proc.kill()
            gen._loaded = False
            gen._proc = None
    except Exception:
        pass

    return {"cancelled": True}
