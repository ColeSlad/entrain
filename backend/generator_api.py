"""Private, browser-facing API for a user's own generator.

GPU calls are injected so auth, upload limits, and job handling can be tested
without a Modal account. Signed job IDs survive API container restarts and only
permit polling/cancelling calls issued here. The signing key never reaches the
browser and MUST differ from the client-visible API token.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import math
import subprocess
import tempfile
import time
import wave
from collections.abc import Awaitable, Callable
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.formparsers import MultiPartException

MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MIN_DURATION_SECONDS = 5
MAX_DURATION_SECONDS = 120
JOB_TTL_SECONDS = 24 * 60 * 60
log = logging.getLogger(__name__)


def normalize_audio(data: bytes) -> bytes:
    """Decode on CPU before reserving a GPU; bound decoded size and duration.

    Return mono PCM WAV so the existing EDGE/Jukebox pipeline receives a known
    format regardless of the upload's filename or codec. External network
    protocols are disabled in the decoder.
    """
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / "upload"
        target = Path(directory) / "input.wav"
        source.write_bytes(data)
        try:
            subprocess.run([
                "ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe",
                "-i", str(source), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "22050",
                "-t", str(MAX_DURATION_SECONDS + 1), "-c:a", "pcm_s16le", str(target),
            ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
            with wave.open(str(target), "rb") as audio:
                duration = audio.getnframes() / audio.getframerate()
        except (subprocess.SubprocessError, wave.Error, EOFError) as error:
            raise HTTPException(422, "Audio could not be decoded within the processing limit") from error
        if not math.isfinite(duration) or not MIN_DURATION_SECONDS <= duration <= MAX_DURATION_SECONDS:
            raise HTTPException(422, f"Audio must be {MIN_DURATION_SECONDS}–{MAX_DURATION_SECONDS} seconds long")
        return target.read_bytes()


def create_generator_api(
    *,
    token: str,
    signing_key: str,
    allowed_origins: list[str],
    submit: Callable[[bytes], Awaitable[str]],
    poll: Callable[[str], Awaitable[dict]],
    cancel: Callable[[str], Awaitable[None]],
    normalize: Callable[[bytes], bytes] = normalize_audio,
) -> FastAPI:
    if len(token) < 32 or len(signing_key) < 32 or token == signing_key:
        raise ValueError("Configure separate, random API and job-signing secrets (at least 32 characters each)")
    if not allowed_origins:
        raise ValueError("Configure at least one allowed website origin")
    for origin in allowed_origins:
        parsed = urlsplit(origin)
        if parsed.scheme != "https" or not parsed.netloc or parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.password:
            raise ValueError("Allowed origins must be exact HTTPS origins without paths")

    auth = HTTPBearer(auto_error=False)

    async def authorize(credentials: HTTPAuthorizationCredentials | None = Depends(auth)) -> None:
        if credentials is None or not hmac.compare_digest(credentials.credentials.encode(), token.encode()):
            raise HTTPException(401, "Invalid Entrain access token", headers={"WWW-Authenticate": "Bearer"})

    api = FastAPI(title="Entrain private generator", docs_url=None, redoc_url=None, openapi_url=None,
                  dependencies=[Depends(authorize)])
    api.add_middleware(CORSMiddleware, allow_origins=allowed_origins,
                       allow_methods=["GET", "POST", "DELETE"], allow_headers=["Authorization", "Content-Type"])

    @api.middleware("http")
    async def private_responses(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    def sign(payload: str) -> str:
        return hmac.new(signing_key.encode(), payload.encode(), hashlib.sha256).hexdigest()

    def call_id(job_id: str) -> str:
        payload, _, signature = job_id.rpartition(".")
        if len(job_id) > 512 or not hmac.compare_digest(sign(payload).encode(), signature.encode()):
            raise HTTPException(404, "Job not found")
        identifier, _, expires = payload.rpartition(".")
        if not expires.isdigit() or not identifier:
            raise HTTPException(404, "Job not found")
        if int(expires) <= time.time():
            raise HTTPException(410, "Job expired")
        return identifier

    @api.get("/health")
    async def health():
        # Connection checks do not invoke or warm the GPU model.
        return {"service": "entrain", "api_version": 1, "mode": "edge",
                "max_upload_bytes": MAX_UPLOAD_BYTES,
                "min_duration_seconds": MIN_DURATION_SECONDS,
                "max_duration_seconds": MAX_DURATION_SECONDS}

    @api.post("/jobs", status_code=202)
    async def create_job(request: Request):
        # Apply a streaming limit, not just Content-Length (which can be absent).
        size = 0

        async def receive():
            nonlocal size
            message = await request.receive()
            size += len(message.get("body", b""))
            if size > MAX_UPLOAD_BYTES + 64 * 1024:  # room for multipart headers
                # Let the multipart parser close any spooled files on failure.
                raise MultiPartException("Upload too large")
            return message

        bounded = Request(request.scope, receive)
        try:
            async with bounded.form(max_files=1, max_fields=0) as form:
                audio = form.get("audio")
                if len(form) != 1 or not isinstance(audio, UploadFile):
                    raise HTTPException(422, "Upload one audio file in the audio field")
                data = await audio.read(MAX_UPLOAD_BYTES + 1)
        except StarletteHTTPException as error:
            if size > MAX_UPLOAD_BYTES + 64 * 1024:
                raise HTTPException(413, "Upload too large") from error
            raise
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "Upload too large")
        if not data:
            raise HTTPException(422, "Audio is empty")
        normalized = await run_in_threadpool(normalize, data)
        try:
            identifier = await submit(normalized)
        except Exception as error:
            log.exception("Could not submit generation")
            raise HTTPException(503, "Generator unavailable") from error
        payload = f"{identifier}.{int(time.time()) + JOB_TTL_SECONDS}"
        return {"job_id": f"{payload}.{sign(payload)}", "status": "running"}

    @api.get("/jobs/{job_id}")
    async def get_job(job_id: str):
        return await poll(call_id(job_id))

    @api.delete("/jobs/{job_id}")
    async def cancel_job(job_id: str):
        await cancel(call_id(job_id))
        return {"status": "cancelled"}

    return api
