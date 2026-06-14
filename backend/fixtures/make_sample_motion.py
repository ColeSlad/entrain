"""Synthesize a short, deterministic SMPL dance as the committed fixture.

Seams-first: this stands in for a real EDGE run so the renderer (Phase 1) and
the retarget (Phase 2) have valid input without the GPU. It is not a real
dance. It is smooth, looping, and deliberately asymmetric so it doubles as the
section 9 validation clip: frame 0 is a clean pose with the LEFT arm raised,
which must read as raised on the correct side once retargeted.

All rotations are LOCAL axis-angle per SMPL joint, as the contract expects.
Run: python backend/fixtures/make_sample_motion.py
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))  # so `pipeline` imports
from pipeline import contracts

FPS = 30
DURATION_S = 4.0
NUM_FRAMES = int(FPS * DURATION_S)  # 120

# SMPL joint indices we animate (see contracts.SMPL_JOINTS ordering).
SPINE1 = 3
L_KNEE, R_KNEE = 4, 5
L_SHOULDER, R_SHOULDER = 16, 17
L_ELBOW = 18

# Nominal SMPL pelvis height in meters. Placeholder; the retarget resolves true
# scale from the hip-height ratio (reference mapRootTranslation).
PELVIS_HEIGHT = 0.9

# Constant left-arm raise applied every frame so any static frame shows it.
# Axis and sign are approximate in SMPL's frame and get confirmed visually in
# Phase 2; the point here is a strong, LEFT-only signal for the left/right
# check. The right shoulder stays neutral so the asymmetry is unambiguous.
LEFT_ARM_RAISE = (0.0, 0.0, 1.2)  # axis-angle, about +Z


def _set(pose, joint, x, y, z):
    pose[joint * 3 + 0] = x
    pose[joint * 3 + 1] = y
    pose[joint * 3 + 2] = z


def _pose_at(t):
    """One frame of local axis-angle, t in [0, 1).

    Oscillations use whole cycles so the clip loops, and each vanishes at t=0
    so frame 0 is a clean validation pose (only the held arm raise remains).
    """
    pose = [0.0] * contracts.POSE_DIM

    _set(pose, L_SHOULDER, *LEFT_ARM_RAISE)  # held raise, every frame

    sway = math.sin(2 * math.pi * 2 * t)
    bob = 1 - math.cos(2 * math.pi * 2 * t)  # 0 at t=0, always >= 0 (knee bend)
    _set(pose, SPINE1, 0.0, 0.15 * sway, 0.0)   # twist about Y
    _set(pose, L_KNEE, 0.20 * bob, 0.0, 0.0)
    _set(pose, R_KNEE, 0.20 * bob, 0.0, 0.0)
    _set(pose, L_ELBOW, 0.0, 0.0, 0.25 * sway)
    _set(pose, R_SHOULDER, 0.0, 0.0, -0.40 * math.sin(2 * math.pi * t))
    return [round(v, 6) for v in pose]


def _root_at(t):
    """Pelvis position in meters: in-place sway plus a vertical bob."""
    x = 0.04 * math.sin(2 * math.pi * t)
    y = PELVIS_HEIGHT + 0.03 * math.sin(2 * math.pi * 2 * t)
    return [round(x, 6), round(y, 6), 0.0]


def main():
    poses, trans, contacts = [], [], []
    for f in range(NUM_FRAMES):
        t = f / NUM_FRAMES
        poses.append(_pose_at(t))
        trans.append(_root_at(t))
        contacts.append([1, 1, 1, 1])  # planted; real EDGE labels come later

    motion = contracts.Motion(
        fps=FPS,
        num_frames=NUM_FRAMES,
        smpl_poses=poses,
        root_translation=trans,
        foot_contact=contacts,
        audio=None,
    )
    out = Path(__file__).parent / "sample_motion.json"
    motion.save(out)  # validates, then writes
    print(f"wrote {out} ({NUM_FRAMES} frames @ {FPS}fps)")


if __name__ == "__main__":
    main()
