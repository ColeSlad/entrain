"""Audio feature extraction for the dance generator.

EDGE consumes per-frame audio features (the EDGE repo uses Jukebox-derived
features; some configs use librosa). Loading and feature prep use librosa
(brief section 5). This is the interface generate.py calls. The exact feature
type must match what the chosen checkpoint expects, so it is wired together
with EDGE rather than guessed here (see docs/SETUP.md).
"""

from __future__ import annotations

from pathlib import Path


def extract_features(audio_path: str | Path, fps: int = 30):
    """Return per-frame audio features for `audio_path`, aligned to `fps`.

    One feature row per motion frame, so the model sees audio and motion on the
    same timeline. Not implemented until EDGE is wired: the feature type
    (Jukebox vs librosa, dimensionality, normalization) must match the EDGE
    checkpoint, so guessing it would silently break generation.
    """
    raise NotImplementedError(
        "audio feature extraction is wired with EDGE; see docs/SETUP.md"
    )
