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
    scaledown_window=300,  # keep the container (and loaded models) warm 5 min
)
class Generator:
    @modal.enter()
    def load(self):
        # Load EDGE once per container so the checkpoint and (after the first
        # request) the Jukebox model stay resident across calls. If anything
        # here fails, generate falls back to the subprocess path, so this
        # optimization can't break the pipeline.
        self.model = None
        try:
            import sys
            sys.path.insert(0, os.environ["EDGE_DIR"])
            os.chdir(os.environ["EDGE_DIR"])
            from EDGE import EDGE
            self.model = EDGE("jukebox", os.environ["EDGE_CHECKPOINT"])
            self.model.eval()
            print("[generate] EDGE model cached in container", flush=True)
        except Exception as e:
            print(f"[generate] model preload failed ({e!r}); using subprocess", flush=True)

    @modal.method()
    def generate(self, audio_bytes: bytes, filename: str) -> dict:
        import tempfile

        suffix = os.path.splitext(filename)[1] or ".wav"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
            f.write(audio_bytes)
            path = f.name

        if self.model is not None:
            try:
                return self._generate_cached(path)
            except Exception as e:
                print(f"[generate] cached path failed ({e!r}); using subprocess", flush=True)
        from pipeline.generate import generate_motion
        return generate_motion(path).to_dict()

    def _generate_cached(self, path: str) -> dict:
        # Replicates EDGE test.py's per-request flow with the preloaded model:
        # slice the song, extract Jukebox features, run render_sample, then map
        # the saved pkl to our Motion contract (same as pipeline.generate).
        import glob
        import pickle
        import random
        import tempfile

        import librosa
        import numpy as np
        import scipy.signal
        import torch  # noqa: F401  (render_sample needs torch initialized)
        from data.slice import slice_audio
        from data.audio_extraction.jukebox_features import extract as juke_extract
        from test import stringintkey

        from pipeline import contracts

        if not hasattr(scipy.signal, "hann"):
            scipy.signal.hann = scipy.signal.windows.hann

        y, sr = librosa.load(path, mono=True)
        with tempfile.TemporaryDirectory() as tmp:
            sl = os.path.join(tmp, "slices")
            motions = os.path.join(tmp, "motions")
            renders = os.path.join(tmp, "renders")
            for d in (sl, motions, renders):
                os.makedirs(d)
            slice_audio(path, 2.5, 5.0, sl)
            file_list = sorted(glob.glob(f"{sl}/*.wav"), key=stringintkey)
            # Cover ~the whole song without exceeding the available slices.
            sample_size = max(1, min(int(len(y) / sr / 2.5) - 1, len(file_list)))
            rand_idx = random.randint(0, len(file_list) - sample_size)
            sel = file_list[rand_idx:rand_idx + sample_size]
            cond = torch.from_numpy(np.array([juke_extract(f)[0] for f in sel]))
            self.model.render_sample(
                (None, cond, sel), "test", renders,
                render_count=-1, fk_out=motions, render=False,
            )
            with open(sorted(glob.glob(f"{motions}/*.pkl"))[0], "rb") as f:
                data = pickle.load(f)
            tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
            beats = [round(float(t), 3) for t in librosa.frames_to_time(beat_frames, sr=sr)]

        poses = data["smpl_poses"]
        trans = data["smpl_trans"]
        n = len(poses)
        return contracts.Motion(
            fps=30,
            num_frames=n,
            smpl_poses=poses.tolist(),
            root_translation=trans.tolist(),
            foot_contact=[[0, 0, 0, 0] for _ in range(n)],
            audio=contracts.Audio(
                bpm=round(float(np.ravel(tempo)[0]), 1),
                beats=beats,
                downbeats=beats[::4],
            ),
        ).validate().to_dict()


@app.local_entrypoint()
def main(audio: str):
    data = Path(audio).read_bytes()
    motion = Generator().generate.remote(data, os.path.basename(audio))
    print(f"Motion: {motion['num_frames']} frames @ {motion['fps']}fps")
