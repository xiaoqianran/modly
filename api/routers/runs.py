"""Call-chain + cost ledger for one generate. Overlay-only; useApi is unchanged."""

from fastapi import APIRouter, HTTPException, Query

from services.run_tracker import list_snapshots, snapshot

router = APIRouter(tags=["runs"])


@router.get("/runs")
async def list_runs(limit: int = Query(20, ge=1, le=80)):
    return {"runs": list_snapshots(limit)}


@router.get("/runs/{job_id}")
async def get_run(job_id: str):
    body = snapshot(job_id)
    if body is None:
        raise HTTPException(404, f"Run {job_id} not found")
    return body
