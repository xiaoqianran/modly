import asyncio
import json
import threading
import traceback
import uuid
from fastapi import APIRouter, File, Form, UploadFile, HTTPException, BackgroundTasks
from services.generators.base import smooth_progress, GenerationCancelled

import re as _re
from services.generator_registry import generator_registry, WORKSPACE_DIR
from services.job_store import get_job_store
from services.modal_runtime import spawn_gpu_generation
from schemas.generation import JobStatus

router = APIRouter(tags=["generation"])


def _purge_old_jobs() -> None:
    get_job_store().purge()


@router.post("/from-image")
async def generate_from_image(
    background_tasks: BackgroundTasks,
    image: UploadFile = File(...),
    model_id: str = Form("sf3d"),
    collection: str = Form("Default"),
    remesh: str = Form("quad"),
    enable_texture: bool = Form(False),
    texture_resolution: int = Form(1024),
    params: str = Form("{}"),
):
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(400, "File must be an image")

    if remesh not in ("quad", "triangle", "none"):
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")

    # Sanitize collection name: strip, forbid path separators and special chars
    collection = collection.strip()
    if not collection or _re.search(r'[/:*?"<>|\\]', collection):
        collection = "Default"

    # Verify the requested model exists in the registry
    try:
        generator_registry.get_generator(model_id)
    except ValueError as e:
        raise HTTPException(400, str(e))

    generator_registry.switch_model(model_id)

    # Parse model-specific params from JSON and merge with common fields
    try:
        model_params = json.loads(params)
    except (json.JSONDecodeError, TypeError):
        model_params = {}

    job_id      = str(uuid.uuid4())
    image_bytes = await image.read()
    full_params = {
        "remesh":             remesh,
        "enable_texture":     enable_texture,
        "texture_resolution": texture_resolution,
        **model_params,
    }

    _purge_old_jobs()

    job = JobStatus(job_id=job_id, status="pending", progress=0)
    store = get_job_store()
    store.put(job)
    store.cancel_event(job_id)

    if spawn_gpu_generation(job_id, model_id, image_bytes, full_params, collection):
        return {"job_id": job_id}

    background_tasks.add_task(_run_generation, job_id, image_bytes, full_params, collection)

    return {"job_id": job_id}



@router.get("/status/{job_id}")
async def job_status(job_id: str):
    job = get_job_store().get(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    return job


@router.post("/cancel/{job_id}")
async def cancel_job(job_id: str):
    store = get_job_store()
    job = store.get(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    store.mark_cancel(job_id)
    # Kill the active generator subprocess immediately so inference stops now.
    # _run_generation will catch the resulting exception, see job_id in _cancelled,
    # and return cleanly without setting an error status.
    try:
        gen = generator_registry._generators.get(generator_registry._active_id)
        if gen is not None and hasattr(gen, "_proc") and gen._proc and gen._proc.poll() is None:
            gen._proc.kill()
            gen._loaded = False
            gen._proc = None
    except Exception:
        pass
    return {"cancelled": True}


async def _run_generation(job_id: str, image_bytes: bytes, params: dict, collection: str = "Default") -> None:
    store = get_job_store()
    job = store.get(job_id)
    if job is None:
        return
    store.update(job_id, status="running")

    def progress_cb(pct: int, step: str = "") -> None:
        current = store.get(job_id)
        if current is None:
            return
        patch: dict = {}
        if pct > current.progress:
            patch["progress"] = pct
        if step:
            patch["step"] = step
        if patch:
            store.update(job_id, **patch)

    try:
        loop = asyncio.get_running_loop()

        # Check if the model needs to be loaded BEFORE calling get_active(),
        # because get_active() loads the model in a blocking manner.
        # active_status() is an instantaneous operation (simple dict lookup).
        if not generator_registry.active_status()["loaded"]:
            active = generator_registry.active_status()
            model_name = active['name']
            init_label = f"Downloading {model_name}…" if not active['downloaded'] else f"Loading {model_name}…"
            progress_cb(0, init_label)
            stop_load_evt = threading.Event()
            load_thread = threading.Thread(
                target=smooth_progress,
                args=(progress_cb, 0, 9, init_label, stop_load_evt, 4.0),
                daemon=True,
            )
            load_thread.start()
            try:
                gen = await loop.run_in_executor(None, generator_registry.get_active)
            finally:
                stop_load_evt.set()
        else:
            gen = await loop.run_in_executor(None, generator_registry.get_active)

        if store.is_cancelled(job_id):
            return

        # Direct output to the collection subfolder
        coll_dir = WORKSPACE_DIR / collection
        coll_dir.mkdir(parents=True, exist_ok=True)
        gen.outputs_dir = coll_dir

        cancel_event = store.cancel_event(job_id)
        import inspect
        supports_cancel = "cancel_event" in inspect.signature(gen.generate).parameters
        output_path = await loop.run_in_executor(
            None,
            lambda: gen.generate(image_bytes, params, progress_cb, cancel_event)
                    if supports_cancel
                    else gen.generate(image_bytes, params, progress_cb),
        )

        if store.is_cancelled(job_id):
            return

        try:
            rel = output_path.relative_to(WORKSPACE_DIR)
            output_url = f"/workspace/{rel.as_posix()}"
        except ValueError:
            output_url = f"/workspace/{collection}/{output_path.name}"
        store.update(job_id, status="done", progress=100, output_url=output_url)
        from services.modal_runtime import commit_volume
        commit_volume("modly-workspace")

    except GenerationCancelled:
        store.update(job_id, status="cancelled")
    except Exception as exc:
        if store.is_cancelled(job_id):
            return
        tb = traceback.format_exc()
        msg = f"[Generation ERROR] {exc}\n{tb}"
        try:
            print(msg)
        except UnicodeEncodeError:
            print(msg.encode("ascii", errors="replace").decode("ascii"))
        store.update(job_id, status="error", error=tb.strip())
