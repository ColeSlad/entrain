# Setup

What you need before running the pipeline. Several assets are license-gated and
are not committed to the repo. Obtain each one once, then point an environment
variable or a known path at it. This file grows as later phases add setup.

## Prerequisites

- Python 3.10.
- A CUDA GPU for local generation, or a Modal account for remote GPU.
- Node 18+ for the frontend (added in a later phase).
- Blender or FBX2glTF to convert the Mixamo character to GLB.

## Environment variables

Set these in your shell or a local `.env` (gitignored, never committed):

- `SMPL_MODEL_DIR`: absolute path to the directory holding the SMPL `.pkl`
  files. Read by the generation and Stage 0 render code; never hardcoded.

More variables (Modal, object storage) arrive in Phase 3.

## 1. SMPL body model

Needed for the Stage 0 SMPL mesh render (Phase 1). Note: EDGE generation does
not need this. The EDGE README has no SMPL download step; test.py emits SMPL
parameters from an internal skeleton. SMPL is only required when we render a
body mesh ourselves.

1. Register and accept the license at smpl.is.tue.mpg.de.
2. Download "version 1.1.0 for Python 2.7 (female/male/neutral, 300 shape PCs)"
   under SMPL for Python Users. 1.1.0 is the only option with the neutral model.
   The "Python 2.7" label is for the sample scripts; the pkl loads in Python 3
   with `pickle.load(f, encoding='latin1')`.
3. Rename the neutral file (e.g. `basicmodel_neutral_lbs_10_207_0_v1.1.0.pkl`)
   to `SMPL_NEUTRAL.pkl` and place it in `backend/data/smpl/`. Confirm the exact
   name against the renderer when Phase 1 lands. Then point the env var there:

   ```
   export SMPL_MODEL_DIR=/Users/colesladowsky/Desktop/Projects/entrain/backend/data/smpl
   ```

These files are non-commercial-licensed and must not be committed. They are
already gitignored (`*.pkl`).

## 2. EDGE checkpoint

The primary dance generator. Source: `Stanford-TML/EDGE`.

1. Clone the repo: `git clone https://github.com/Stanford-TML/EDGE.git`.
2. Download the checkpoint. EDGE ships `download_model.sh`, but its wget Google
   Drive trick often fails on the confirm step. gdown is more reliable:

   ```
   pip install gdown
   gdown 1BAR712cVEqB8GR37fcEihRV_xOC-fZrZ -O checkpoint.pt
   ```

   Or download in a browser from
   https://drive.google.com/file/d/1BAR712cVEqB8GR37fcEihRV_xOC-fZrZ/view
   (saves as `checkpoint.pt`).
3. Move it to `backend/checkpoints/checkpoint.pt` (gitignored).
4. Pin the file and record its hash so a swapped checkpoint is caught:

   ```
   shasum -a 256 backend/checkpoints/checkpoint.pt
   ```

   Recorded hash: TODO, fill in after the first download.

Running EDGE also needs its environment: Python 3.7+, PyTorch 1.12.1, pytorch3d,
jukemirlib, and accelerate (run `accelerate config`, fp16). modal_app.py wraps
this. The EDGE weights are for research and non-commercial use. Do not
redistribute or bundle them.

## 3. Mixamo character (the single fixed target rig)

Our one fixed playback character. Mixamo assets are free to use, so unlike SMPL
and EDGE this asset is committed.

1. Mixamo (mixamo.com) is free with an Adobe account. Pick one character; Y Bot
   or X Bot are clean defaults. Download it in T-pose.
2. Mixamo exports FBX, not GLB. Convert to GLB:
   - Blender: import the FBX, then export as glTF Binary (`.glb`), or
   - FBX2glTF: `FBX2glTF -b -i character.fbx -o character.glb`.
3. Confirm the bone names carry the `mixamorig:` prefix. They must match the
   map in `reference/smpl_to_mixamo_retarget.js`.
4. Commit the result at `assets/character.glb`.

## 4. AIST++ (not needed yet)

Only for later finetuning or evaluation. Do not download it for MVP inference.

## 5. Modal (generation compute)

1. Create a Modal account and run `modal token new`.
2. Default GPU is A10G. Move to A100 only if the model needs it.
3. Bring the SMPL files and the EDGE checkpoint into the image through a Modal
   Volume, not baked into the image. They are large and license-gated.
4. Cache the loaded model between requests. Do not reload weights per job, to
   avoid cost and cold-start penalties.

## GPU memory

The model plus SMPL can be heavy. If you hit OOM on A10G, reduce the batch or
sequence length before reaching for a bigger GPU.
