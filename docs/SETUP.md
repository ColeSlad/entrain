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

The dance model and the Stage 0 render both need this.

1. Register and accept the license at smpl.is.tue.mpg.de.
2. Download the SMPL body model. Neutral is enough for the MVP; male and female
   are optional.
3. Place the `.pkl` files under `SMPL_MODEL_DIR`. Match the exact filenames and
   folder layout the EDGE repo expects (see its README), since EDGE loads the
   SMPL pkl from a specific path.

These files are non-commercial-licensed and must not be committed. They are
already gitignored (`*.pkl`).

## 2. EDGE checkpoint

The primary dance generator. Source: `Stanford-TML/EDGE`.

1. Follow the EDGE README to download the pretrained checkpoint.
2. Place it under `backend/checkpoints/` (gitignored).
3. Pin the exact file and record its hash so a swapped checkpoint is caught:

   ```
   shasum -a 256 backend/checkpoints/<checkpoint-file>
   ```

   Recorded hash: TODO, fill in after the first download.

The EDGE weights are for research and non-commercial use. Do not redistribute
or bundle them. Note the license terms from the EDGE repo.

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
