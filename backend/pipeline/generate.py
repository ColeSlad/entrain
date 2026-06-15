"""generate_motion: the single swappable entry point to the dance generator.

Keeping the model behind one function lets us swap EDGE for Lodge later without
touching callers (brief sections 3 and 12).

Two paths, chosen by the EDGE_DIR env var:
- EDGE_DIR unset (local dev): return the committed fixture, so the rest of the
  pipeline and the frontend work without a GPU (seams first, section 4).
- EDGE_DIR set (the Modal image): run EDGE's test.py as a subprocess and convert
  the motion pkl it saves into our Motion contract.

Run: python -m pipeline.generate <song.wav>   (from the backend/ directory)
"""

from __future__ import annotations

import os
import pickle
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from . import contracts

FIXTURE = Path(__file__).parent.parent / "fixtures" / "sample_motion.json"


def generate_motion(audio_path: str | Path) -> contracts.Motion:
    """Generate SMPL dance motion for one audio file."""
    edge_dir = os.environ.get("EDGE_DIR")
    if not edge_dir:
        print(f"[generate] EDGE_DIR unset; returning fixture for {audio_path}",
              file=sys.stderr)
        return contracts.Motion.load(FIXTURE)
    return _generate_with_edge(Path(audio_path), Path(edge_dir))


def _generate_with_edge(audio_path: Path, edge_dir: Path) -> contracts.Motion:
    """Run EDGE as a subprocess in its own repo, then read the motion it saves.

    Treating EDGE as a black box (its repo, its pinned deps) keeps us decoupled
    from its internal API. EDGE saves a pkl with axis-angle smpl_poses (N, 72)
    and smpl_trans (N, 3); the contact channel is not saved, so foot_contact is
    zero-filled until Phase 6.
    """
    checkpoint = os.environ.get("EDGE_CHECKPOINT", "/assets/checkpoint.pt")
    with tempfile.TemporaryDirectory() as tmp:
        music_dir = Path(tmp) / "music"
        out_dir = Path(tmp) / "motions"
        renders_dir = Path(tmp) / "renders"
        music_dir.mkdir()
        out_dir.mkdir()
        renders_dir.mkdir()
        # EDGE wants simple, regularized filenames (no spaces).
        shutil.copy(audio_path, music_dir / "input.wav")
        subprocess.run(
            [
                "python", "test.py",
                "--music_dir", str(music_dir),
                "--save_motions", "--motion_save_dir", str(out_dir),
                # EDGE writes an audio wav into render_dir even with --no_render,
                # and saves the motion only after that, so the dir must exist.
                "--render_dir", str(renders_dir),
                "--no_render",
                "--checkpoint", str(checkpoint),
                "--feature_type", "jukebox",
            ],
            cwd=str(edge_dir),
            check=True,
        )
        pkls = sorted(out_dir.glob("*.pkl"))
        if not pkls:
            raise RuntimeError("EDGE produced no motion pkl")
        data = pickle.loads(pkls[0].read_bytes())

    poses = data["smpl_poses"]        # (N, 72) axis-angle, already converted
    trans = data["smpl_trans"]        # (N, 3) meters, pelvis
    n = len(poses)
    return contracts.Motion(
        fps=30,                        # EDGE generates at 30 fps
        num_frames=n,
        smpl_poses=poses.tolist(),
        root_translation=trans.tolist(),
        foot_contact=[[0, 0, 0, 0] for _ in range(n)],
        audio=None,
    ).validate()


def _main(argv: list[str]) -> int:
    if len(argv) != 1:
        print("usage: python -m pipeline.generate <song.wav>", file=sys.stderr)
        return 2
    motion = generate_motion(argv[0]).validate()
    print(
        f"Motion OK: {motion.num_frames} frames @ {motion.fps}fps, "
        f"poses[{len(motion.smpl_poses)}][{len(motion.smpl_poses[0])}], "
        f"audio={'present' if motion.audio else 'null'}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
