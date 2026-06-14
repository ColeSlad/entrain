"""Motion data contract (brief section 8).

This is the frozen seam between generation, retargeting, and the frontend.
Everything stores axis-angle rotations; rotation normalization lives here so it
happens once (risk register), not scattered across callers.

The core contract (dataclasses, (de)serialization, validation) is pure stdlib
so a fixture can be loaded and validated without the heavy ML stack. Only the
6D rotation conversion pulls numpy/scipy, and it does so lazily.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

# SMPL body model: 24 joints, 3 axis-angle params each.
NUM_JOINTS = 24
POSE_DIM = NUM_JOINTS * 3  # 72
TRANS_DIM = 3              # pelvis translation, meters
FOOT_DIM = 4              # EDGE foot-contact labels: [LH, LF, RH, RF], 0/1


@dataclass
class Section:
    """A labeled span of the song (e.g. chorus, drop). Times in seconds."""

    label: str
    start: float
    end: float


@dataclass
class Audio:
    """Music structure for Phase 5. Null on a Motion until then."""

    bpm: Optional[float] = None
    beats: list[float] = field(default_factory=list)       # seconds
    downbeats: list[float] = field(default_factory=list)   # seconds
    sections: list[Section] = field(default_factory=list)


@dataclass
class Motion:
    """One generated dance as SMPL motion. See brief section 8 for the shape."""

    fps: int                                  # EDGE is 30; AIST++ data is 60
    num_frames: int
    smpl_poses: list[list[float]]             # [num_frames][72] axis-angle
    root_translation: list[list[float]]       # [num_frames][3] meters, pelvis
    foot_contact: list[list[float]]           # [num_frames][4] EDGE labels, 0/1
    audio: Optional[Audio] = None             # filled in Phase 5, null before

    def validate(self) -> "Motion":
        """Enforce the section 8 shape. Raises ValueError on any violation.

        Both sides of the seam trust a validated Motion, so this is strict on
        the arrays the renderer and retargeter depend on. Audio is Phase 5 and
        only structurally checked via from_dict.
        """
        if self.fps <= 0:
            raise ValueError(f"fps must be positive, got {self.fps}")
        n = self.num_frames
        if n <= 0:
            raise ValueError(f"num_frames must be positive, got {n}")

        for name, seq, width in (
            ("smpl_poses", self.smpl_poses, POSE_DIM),
            ("root_translation", self.root_translation, TRANS_DIM),
            ("foot_contact", self.foot_contact, FOOT_DIM),
        ):
            if len(seq) != n:
                raise ValueError(
                    f"{name} has {len(seq)} frames, expected num_frames={n}"
                )
            for i, row in enumerate(seq):
                if len(row) != width:
                    raise ValueError(
                        f"{name}[{i}] has length {len(row)}, expected {width}"
                    )

        for i, row in enumerate(self.foot_contact):
            for v in row:
                if v not in (0, 1):
                    raise ValueError(
                        f"foot_contact[{i}] has non-binary value {v}"
                    )
        return self

    def to_dict(self) -> dict:
        """JSON-ready dict matching the section 8 schema (audio -> null/object)."""
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Motion":
        audio_d = d.get("audio")
        audio = None
        if audio_d is not None:
            audio = Audio(
                bpm=audio_d.get("bpm"),
                beats=list(audio_d.get("beats", [])),
                downbeats=list(audio_d.get("downbeats", [])),
                sections=[Section(**s) for s in audio_d.get("sections", [])],
            )
        return cls(
            fps=d["fps"],
            num_frames=d["num_frames"],
            smpl_poses=d["smpl_poses"],
            root_translation=d["root_translation"],
            foot_contact=d["foot_contact"],
            audio=audio,
        )

    def save(self, path: str | Path) -> None:
        """Validate, then write the fixture/payload JSON."""
        self.validate()
        Path(path).write_text(json.dumps(self.to_dict()))

    @classmethod
    def load(cls, path: str | Path) -> "Motion":
        """Read and validate a Motion JSON."""
        motion = cls.from_dict(json.loads(Path(path).read_text()))
        return motion.validate()


def rot6d_to_axis_angle(rot6d):
    """Convert 6D continuity rotations (Zhou et al. 2019) to axis-angle.

    EDGE emits joint rotations as 6D, but the contract and the downstream
    forward-kinematics expect axis-angle (section 8, risk register). The 6D
    vector holds the first two basis vectors of the rotation matrix; the third
    is recovered by Gram-Schmidt.

    Convention note (verify before trusting): this matches pytorch3d's
    rotation_6d_to_matrix, which stacks the basis vectors as ROWS. EDGE uses
    pytorch3d, so this should agree, but a row/column swap is a transpose and
    silently inverts every rotation. When generate.py is wired, round-trip a
    sample against pytorch3d to confirm before generating the real fixture.

    Accepts an array shaped [..., 6], returns [..., 3]. If a source already
    emits axis-angle, the caller stores it directly and skips this.
    """
    import numpy as np
    from scipy.spatial.transform import Rotation

    arr = np.asarray(rot6d, dtype=np.float64)
    a1 = arr[..., 0:3]
    a2 = arr[..., 3:6]
    b1 = a1 / np.linalg.norm(a1, axis=-1, keepdims=True)
    a2_proj = a2 - np.sum(b1 * a2, axis=-1, keepdims=True) * b1
    b2 = a2_proj / np.linalg.norm(a2_proj, axis=-1, keepdims=True)
    b3 = np.cross(b1, b2)

    # Rows, to match pytorch3d (see convention note above).
    mats = np.stack([b1, b2, b3], axis=-2)
    rotvec = Rotation.from_matrix(mats.reshape(-1, 3, 3)).as_rotvec()
    return rotvec.reshape(arr.shape[:-1] + (3,))
