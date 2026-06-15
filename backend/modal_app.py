"""Modal app: GPU image that runs EDGE, plus the generation entrypoint.

This replaces the Phase 0 stub with the real EDGE stack. EDGE has no
requirements.txt, so the dependency list below is curated from its README
(PyTorch 1.12.1, pytorch3d, jukemirlib, accelerate) plus the libraries its
inference imports. Expect to iterate this on the first Modal run; the usual
friction points are the pytorch3d wheel matching the torch/CUDA/Python combo
and the multi-GB Jukebox weight download.

generate_motion runs EDGE as a subprocess (see generate.py) because EDGE_DIR is
set here. SMPL pkl files are not needed: EDGE uses a hardcoded skeleton, not the
licensed model.

Setup once:
    modal volume put entrain-assets backend/checkpoints/checkpoint.pt /checkpoint.pt
Run from backend/:
    modal run modal_app.py --audio <song.wav>
"""

import os
from pathlib import Path

import modal

app = modal.App("entrain-generate")

# The EDGE checkpoint lives on a Volume (license-gated and large, not baked in).
assets = modal.Volume.from_name("entrain-assets", create_if_missing=True)
ASSETS_DIR = "/assets"

# Persistent cache for the ~10GB Jukebox weights. jukemirlib caches them at
# ~/.cache/jukemirlib (hardcoded, no env override), so mount the volume at
# exactly that path. Mounting the parent ~/.cache fails because pip already
# populated it at build time, and Modal requires an empty mount target.
cache = modal.Volume.from_name("entrain-cache", create_if_missing=True)
CACHE_MOUNT = "/root/.cache/jukemirlib"

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("git", "ffmpeg", "libsndfile1", "wget")
    # PyTorch 1.12.1 with CUDA, as EDGE pins.
    .pip_install(
        "torch==1.12.1+cu113",
        "torchvision==0.13.1+cu113",
        extra_index_url="https://download.pytorch.org/whl/cu113",
    )
    # pytorch3d prebuilt wheel for this exact python/cuda/torch combo. If this
    # link 404s, the fallback is building from source on a CUDA devel base.
    .pip_install(
        "pytorch3d",
        find_links="https://dl.fbaipublicfiles.com/pytorch3d/packaging/wheels/py310_cu113_pyt1121/download.html",
    )
    # jukemirlib (Jukebox features) plus EDGE's other inference deps. Curated
    # from the README and imports since there is no upstream requirements.txt.
    .pip_install(
        "git+https://github.com/rodrigo-castellon/jukemirlib.git",
        "accelerate",
        "einops",
        "librosa",
        "soundfile",
        "scipy",
        "matplotlib",
        "p_tqdm",
        "tqdm",
        "wandb",
    )
    .run_commands("git clone https://github.com/Stanford-TML/EDGE.git /edge")
    .env(
        {
            "EDGE_DIR": "/edge",
            "EDGE_CHECKPOINT": f"{ASSETS_DIR}/checkpoint.pt",
            # EDGE imports wandb; disable it so inference never tries to log in.
            "WANDB_MODE": "disabled",
            # accelerate pulled in torch >=2.6, whose torch.load defaults to
            # weights_only=True and rejects EDGE's pickled Normalizer. Force the
            # legacy behavior so the checkpoint loads.
            "TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD": "1",
            "PYTHONUNBUFFERED": "1",
        }
    )
    .add_local_python_source("pipeline")
)


@app.cls(
    gpu="A10G",  # bump to "A100" if Jukebox feature extraction OOMs
    image=image,
    volumes={ASSETS_DIR: assets, CACHE_MOUNT: cache},
    timeout=1800,  # cold start plus the first Jukebox download can take minutes
)
class Generator:
    # Note: generate_motion shells out to EDGE's test.py, which reloads the
    # model per call. Caching the model in @modal.enter is a later optimization
    # (risk register) once the subprocess path is confirmed working.
    @modal.method()
    def generate(self, audio_bytes: bytes, filename: str) -> dict:
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
