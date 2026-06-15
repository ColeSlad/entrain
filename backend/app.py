"""FastAPI app: accept an audio upload, run generation as a job, serve results.

Generation runs either locally (the generate_motion stand-in, returns the
committed fixture) or, with ENTRAIN_MODAL_GENERATE=1, on the deployed Modal
Generator (real EDGE). R2 and Neon are deferred: jobs live in memory and the
result is the section 8 Motion JSON, which the frontend retargets in the
browser (so no server-side GLB baking yet).

Run from the backend/ directory:
    uvicorn app:app --reload                       # local stand-in
    ENTRAIN_MODAL_GENERATE=1 uvicorn app:app       # real EDGE on Modal
"""

from __future__ import annotations

import os
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

# Dispatch to the deployed Modal Generator (real EDGE) when set; otherwise run
# the local stand-in. Either way the result is a section 8 Motion dict.
USE_MODAL = os.environ.get("ENTRAIN_MODAL_GENERATE") == "1"


def _run_job(job_id: str, audio_path: str) -> None:
    """Run generation in the background and record the result on the job."""
    try:
        if USE_MODAL:
            import modal

            generator = modal.Cls.from_name("entrain-generate", "Generator")
            motion = generator().generate.remote(
                Path(audio_path).read_bytes(), Path(audio_path).name
            )
        else:
            motion = generate_motion(audio_path).to_dict()
        _jobs[job_id] = {"status": "done", "motion": motion, "error": None}
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
