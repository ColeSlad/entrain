"""Modal app: GPU image and the generation entrypoint.

Phase 0 scope is standing up the image and running generate_motion on a GPU.
The job API and storage are Phase 3, not here. SMPL files and the EDGE
checkpoint are mounted from a Volume, not baked into the image (license-gated
and large, brief section 6). The model loads once per container and is cached,
not reloaded per call (risk register).

Not runnable until `modal` is installed, a token is set (`modal token new`),
and the Volume holds SMPL plus the checkpoint (docs/SETUP.md). Run from the
backend/ directory: `modal run modal_app.py --audio <song.wav>`.
"""

import os
from pathlib import Path

import modal

app = modal.App("entrain-generate")

# SMPL pkl and the EDGE checkpoint live here, populated out of band per
# docs/SETUP.md. SMPL_MODEL_DIR points the pipeline at the mounted files.
assets = modal.Volume.from_name("entrain-assets", create_if_missing=True)
ASSETS_DIR = "/assets"

# CUDA-matched torch plus EDGE deps. Pin exact versions against the EDGE repo's
# requirements when the image is first built (TODO), then freeze them here.
image = (
    modal.Image.debian_slim(python_version="3.10")
    .pip_install(
        "torch",        # install the CUDA build matching the A10G image
        "librosa",
        "einops",
        "accelerate",
        # TODO: add the rest of EDGE's requirements (pytorch3d, jukemirlib, ...)
    )
    .env({"SMPL_MODEL_DIR": f"{ASSETS_DIR}/smpl"})
    .add_local_python_source("pipeline")  # ship our pipeline package
)


@app.cls(gpu="A10G", image=image, volumes={ASSETS_DIR: assets})
class Generator:
    @modal.enter()
    def load(self):
        # Load EDGE plus SMPL once per container so weights are not reloaded
        # per job (risk register). Wired with EDGE; see generate.py.
        pass

    @modal.method()
    def generate(self, audio_bytes: bytes, filename: str) -> dict:
        # Persist the upload, run the swappable generate_motion seam, return the
        # Motion as the section 8 dict for the caller to serialize.
        import tempfile

        from pipeline.generate import generate_motion

        suffix = os.path.splitext(filename)[1] or ".wav"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
            f.write(audio_bytes)
            path = f.name
        return generate_motion(path).to_dict()


@app.local_entrypoint()
def main(audio: str):
    data = Path(audio).read_bytes()
    motion = Generator().generate.remote(data, os.path.basename(audio))
    print(f"Motion: {motion['num_frames']} frames @ {motion['fps']}fps")
