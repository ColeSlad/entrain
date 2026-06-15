"""FastAPI app: accept an audio upload, run generation as a job, serve results.

Phase 3 local version. Generation is the generate_motion stand-in (returns the
committed fixture) until EDGE is wired; the job and polling shape already match
what the real async pipeline needs. Modal, R2, and Neon are deferred: jobs live
in memory and the result is the section 8 Motion JSON, which the frontend
retargets in the browser (so no server-side GLB baking yet).

Run from the backend/ directory:
    uvicorn app:app --reload
"""

from __future__ import annotations

import tempfile
import uuid
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from pipeline.generate import generate_motion

app = FastAPI(title="entrain")

# The dev frontend runs on a Vite port that can vary; allow any localhost origin.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://localhost:\d+",
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory job store: id -> {status, motion (section 8 dict | None), error}.
_jobs: dict[str, dict] = {}


def _run_job(job_id: str, audio_path: str) -> None:
    """Run generation in the background and record the result on the job."""
    try:
        motion = generate_motion(audio_path)
        _jobs[job_id] = {"status": "done", "motion": motion.to_dict(), "error": None}
    except Exception as e:  # surface the failure to the poller
        _jobs[job_id] = {"status": "error", "motion": None, "error": str(e)}
    finally:
        Path(audio_path).unlink(missing_ok=True)


@app.post("/jobs")
async def create_job(audio: UploadFile, background: BackgroundTasks) -> dict:
    suffix = Path(audio.filename or "song.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(await audio.read())
        path = f.name
    job_id = uuid.uuid4().hex
    _jobs[job_id] = {"status": "running", "motion": None, "error": None}
    background.add_task(_run_job, job_id, path)
    return {"job_id": job_id, "status": "running"}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str) -> dict:
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job
