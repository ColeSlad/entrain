"""generate_motion: the single swappable entry point to the dance generator.

Keeping the model behind one function lets us swap EDGE for Lodge later without
touching callers (brief sections 3 and 12). EDGE is not wired yet (needs SMPL
plus the checkpoint, see docs/SETUP.md), so until then this returns the
committed fixture, letting the rest of the pipeline and the frontend develop
against a real Motion (seams first, section 4).

Run: python -m pipeline.generate <song.wav>   (from the backend/ directory)
"""

from __future__ import annotations

import sys
from pathlib import Path

from . import contracts

FIXTURE = Path(__file__).parent.parent / "fixtures" / "sample_motion.json"


def generate_motion(audio_path: str | Path) -> contracts.Motion:
    """Generate SMPL dance motion for one audio file.

    Stand-in until EDGE is wired: returns the committed fixture regardless of
    input so callers can build against a real Motion. Replace the body below
    with the EDGE call once SMPL and the checkpoint are available.
    """
    print(f"[generate] EDGE not wired yet; returning fixture for {audio_path}",
          file=sys.stderr)
    # TODO(phase0): wrap EDGE here, then normalize once through the contract.
    #   feats = audio.extract_features(audio_path)
    #   raw   = edge_model(feats)                       # 6D rotations
    #   poses = contracts.rot6d_to_axis_angle(raw)      # verify convention
    #   return contracts.Motion(fps=30, ...).validate()
    return contracts.Motion.load(FIXTURE)


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
