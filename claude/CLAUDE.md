# Build Brief: Music-to-3D-Dance Web App

You are helping me build a web app that takes a music track and produces a 3D
character dancing to it in the browser. This document is the source of truth
for scope, architecture, and the order of work. Read it fully before writing
code. When something here conflicts with a quick assumption you would otherwise
make, this document wins.

---

## 0. How to work

- Start every phase by writing a short plan, then confirm it with me before
  large or irreversible moves (new top-level dependency, switching a core
  library, changing a data contract). Small steps inside an agreed phase do not
  need confirmation.
- Build strictly phase by phase in the order below. Do not scaffold later
  phases early. Each phase has an acceptance test; the phase is not done until
  that test passes and you have shown me it passing.
- Keep commits small and runnable. Never leave the repo in a broken state
  between phases.
- Do NOT train any model from scratch. We use pretrained checkpoints. If a phase
  seems to require training, stop and ask.
- Do not add dependencies casually. Prefer the ones pinned in section 5.
- When you hit the retargeting work (Phase 2), follow section 9 exactly. It is
  the highest-risk part and the most common source of silent bugs.

---

## 1. Mission and MVP

Input: an audio file (a song, 30 to 120 seconds). Output: a rigged 3D character
performing a generated dance synchronized to that audio, playable in the browser
with basic transport controls.

MVP definition (everything past this is later phases):
- Upload a song, the backend generates dance motion, the frontend plays a
  Mixamo-style character dancing to it on a simple stage, with play/pause/scrub.

Explicit non-goals for now:
- No real-time / live-streaming generation. Generation is an offline job.
- No arbitrary user-supplied characters. We support exactly one fixed character
  first.
- No model training or finetuning in the MVP.
- No multiplayer, accounts, or payments.

This is a research and portfolio project. Several dependencies (SMPL body model,
AIST++, the dance checkpoints) are non-commercial research licenses. Do not ship
this commercially. Surface license notes where relevant; do not silently bundle
restricted weights.

---

## 2. Reference architecture

The pipeline mirrors the Kinetik project (text-to-animated-3D scene editor),
except we replace its text-to-motion stage with music-to-dance.

```
  audio file
      |
      v
 [audio features]  librosa / Jukebox features as the chosen model expects
      |
      v
 [music-to-dance model]  pretrained EDGE (primary)  -> SMPL motion per frame
      |                   (24 joints + root translation + foot-contact labels)
      v
 [retarget]  SMPL skeleton -> ONE fixed Mixamo glTF rig   (section 9)
      |
      v
 [motion payload]  GLB with baked animation, plus optional motion+beat JSON
      |
      v
 [Three.js frontend]  GLTFLoader + AnimationMixer + transport UI
```

---

## 3. Components and responsibilities

- Backend (Python, FastAPI on Modal, GPU): accepts an audio upload, runs the
  generation + retarget pipeline as a job, stores the result, exposes job
  status and result URLs.
- Generation module: wraps the pretrained dance model, returns SMPL motion as a
  plain array structure (see contract in section 8). Isolated behind one
  function so we can swap EDGE for Lodge later without touching callers.
- Retarget module: SMPL motion -> animation on the fixed target rig. Implemented
  per section 9. Outputs a GLB.
- Frontend (React + Vite + Three.js): upload UI, job polling, 3D viewer with
  the character, transport controls.

---

## 4. Build the seams first

Before any model runs, define and freeze the data contract in section 8 and
build both sides against a hardcoded sample. Generate one SMPL motion file once
(by hand-running the model in a notebook) and commit it as a fixture. The
frontend and retarget code develop against that fixture so we are never blocked
on GPU availability.

---

## 5. Tech stack (pinned)

- Python 3.10. PyTorch with CUDA matching the Modal GPU image.
- FastAPI + uvicorn for the backend API.
- Modal for GPU compute and deployment. Default to an A10G; move to A100 only if
  the model needs it.
- librosa for audio loading and feature prep.
- Dance model: EDGE (`Stanford-TML/EDGE`) as the primary generator. Keep the
  call behind a single `generate_motion(audio_path) -> Motion` function.
- SMPL body model (from smpl.is.tue.mpg.de) for the Stage 0 mesh render and for
  joint definitions.
- Frontend: React + Vite + TypeScript, Three.js (current stable), GLTFLoader,
  AnimationMixer. Use `SkeletonUtils` from `three/examples/jsm/utils` if we take
  the library retarget path.
- Storage: local disk for dev. For deploy, object storage (Cloudflare R2 or S3)
  for GLB outputs; a small Postgres (Neon) for job records. Add storage only at
  Phase 3, not before.

Do not introduce a different web framework, a different 3D engine, or a
different dance model without asking.

---

## 6. External dependencies and setup friction

These are the things most likely to cost a day if mishandled. Handle them
explicitly and document the steps in `docs/SETUP.md` as you go.

1. SMPL model files require registration and acceptance of a license at
   smpl.is.tue.mpg.de. They cannot be committed to the repo. Read their path
   from an env var; document how to obtain them. The dance model also needs
   them.
2. EDGE checkpoint: download per the EDGE repo instructions. Pin the exact
   checkpoint and document its hash. Note its license.
3. AIST++ is only needed if we later finetune or evaluate; not needed for MVP
   inference. Do not download it in early phases.
4. Mixamo character: download one rigged character as glTF/GLB (a T-pose,
   without-skin or with-skin per need). Commit the GLB (Mixamo assets are free
   to use). This is our single fixed target rig.
5. GPU memory: the model plus SMPL can be heavy. If you hit OOM on A10G, reduce
   batch/sequence length before reaching for a bigger GPU.

---

## 7. Repo structure (target)

```
backend/
  app.py              FastAPI app, routes: POST /jobs, GET /jobs/{id}
  pipeline/
    generate.py       generate_motion(audio_path) -> Motion  (wraps EDGE)
    audio.py          feature extraction
    retarget.py       SMPL -> Mixamo GLB  (section 9)
    smpl_render.py    Stage 0: SMPL pose -> posed mesh GLB
    contracts.py      Motion dataclass + JSON (de)serialization (section 8)
  modal_app.py        Modal entrypoints / GPU image definition
  fixtures/
    sample_motion.json   committed fixture from a one-off model run
frontend/
  src/
    App.tsx
    Viewer.tsx        Three.js scene, character, AnimationMixer
    Transport.tsx     play / pause / scrub
    api.ts            upload + poll
assets/
  character.glb       the single fixed Mixamo rig
docs/
  SETUP.md
reference/
  smpl_to_mixamo_retarget.js   the retarget reference module (provided)
```

---

## 8. Data contract (freeze this early)

The generation module returns this structure. Serialize to JSON for fixtures and
for the optional editing payload. `R` is the rotation representation the model
emits; normalize everything to axis-angle internally.

```jsonc
{
  "fps": 30,                         // EDGE is 30; AIST++ data is 60
  "num_frames": 1800,
  "smpl_poses": [[ /* 24 * 3 axis-angle */ ]],   // shape [num_frames][72]
  "root_translation": [[0,0,0]],     // shape [num_frames][3], meters, pelvis
  "foot_contact": [[0,0,0,0]],       // shape [num_frames][4], EDGE labels, 0/1
  "audio": {                          // filled in Phase 5, null before
    "bpm": null,
    "beats": [],                      // seconds
    "downbeats": [],                  // seconds
    "sections": []                    // [{label, start, end}], e.g. chorus/drop
  }
}
```

The backend result delivered to the frontend is a GLB with the retargeted
animation baked in (simplest for the viewer), plus this JSON when present. The
GLB is the playback path; the JSON is for future editing and beat features.

---

## 9. The retarget spec (highest risk, follow exactly)

A reference implementation is in `reference/smpl_to_mixamo_retarget.js`. Use it.
The same logic applies whether you retarget in the browser (Three.js
`SkeletonUtils`) or server-side; the MVP bakes the result into a GLB server-side
or in a one-off build step. Implement in whichever language the chosen path
needs, but the rules are identical.

SMPL skeleton: 24 joints, fixed kinematic tree. The dance model emits LOCAL
rotations; forward-kinematics them down the tree to get GLOBAL (world) rotations
before retargeting.

Bone map, SMPL name -> Mixamo bone. Two naming offsets cause most failures:
- SMPL `collar` is the clavicle -> Mixamo `Shoulder`.
- SMPL `shoulder` is the upper arm -> Mixamo `Arm`.
- SMPL `ankle` -> Mixamo `Foot`.
- SMPL `foot` is the toe -> Mixamo `ToeBase`.
- `spine1/2/3` -> `Spine/Spine1/Spine2`. `pelvis` -> `Hips`. `neck`/`head` direct.
- `left_hand`/`right_hand` unmapped for body-only SMPL. Mixamo fingers and end
  bones get no source and hold their rest rotation.

Rest-pose correction (the core): joint rotations are relative to each skeleton's
own rest pose, and SMPL rests arms-down while Mixamo rests in a T-pose, so you
cannot copy local rotations. In world space, per mapped bone:

```
M(j)           = R_srcAnim(j) * inverse(R_srcRest(j))      // motion vs own rest
R_tgtGlobal(b) = M(j) * R_tgtRest(b)
R_tgtLocal(b)  = inverse(R_tgtGlobal(parent_b)) * R_tgtGlobal(b)
```

Process bones parent-before-child so the parent global is ready when localizing
the child. Premultiply a single coordinate-fix quaternion into both the source
animation globals and the source rest globals if the source frame is not Y-up
(Z-up to Y-up is -90 degrees about X). Scale root translation by
(target hip height / SMPL hip height) and rotate it by the same coordinate fix.

Validation rule, do this before pressing play: get ONE static frame correct.
Confirm the character is upright (coordinate fix) and that a known pose such as a
raised arm appears raised on the correct side. Debugging alignment on a moving
clip is miserable; never start there.

Foot contact and IK cleanup are Phase 6 polish, not MVP. The `foot_contact`
labels exist so we can later pin feet during contact frames and run light IK so
feet do not slide on a character whose leg length differs from SMPL.

---

## 10. Build phases

Each phase: goal, tasks, acceptance test. Do not advance until the test passes.

### Phase 0 — Generation works in isolation
Goal: produce SMPL motion from a wav, outside any app.
Tasks: stand up the Modal GPU image; install EDGE and deps; obtain SMPL + EDGE
checkpoint; run the model on one sample song in a script/notebook; write the
result through `contracts.py` and commit it as `fixtures/sample_motion.json`.
Acceptance: `python -m pipeline.generate <song.wav>` prints a valid Motion
matching the section 8 schema, and the fixture is committed.

### Phase 1 — Stage 0 render, no retargeting
Goal: see the dance in 3D as a plain SMPL body, proving the generate-to-render
loop.
Tasks: `smpl_render.py` runs the SMPL body model forward on the fixture poses,
exports a GLB with the 24-bone skeleton animation; a minimal static HTML/Three
page loads and plays it.
Acceptance: a grey SMPL body dances in the browser to the sample timing.

### Phase 2 — Retarget to the fixed Mixamo character
Goal: the real character dances.
Tasks: implement section 9 against `assets/character.glb`; first render the
single validation frame, show it to me, then animate.
Acceptance: the Mixamo character performs the fixture dance with correct
orientation and limbs, no inside-out joints, no lying on its back.

### Phase 3 — End-to-end app
Goal: upload to playback through the real services.
Tasks: FastAPI `POST /jobs` (accept audio, enqueue), `GET /jobs/{id}` (status +
result GLB URL); Modal runs the pipeline; add R2/S3 for the GLB and Neon for job
records; React app uploads, polls, and plays the returned GLB in `Viewer.tsx`.
Acceptance: from the running frontend, I upload a song and watch the character
dance to it, with no manual steps in between.

### Phase 4 — Transport and quality of life
Goal: usable playback.
Tasks: play/pause/scrub bound to the AnimationMixer; loading and error states;
basic camera orbit; a clean default stage (ground, lights).
Acceptance: I can scrub to any point and the pose is correct; errors surface
clearly.

### Phase 5 — Beat-aware choreography (the differentiator)
Goal: motion that visibly responds to song structure.
Tasks: run the All-In-One music structure analyzer to fill the `audio` block
(bpm, beats, downbeats, sections); use downbeats/drop to bias generation or clip
selection so the biggest movement lands on the drop; visualize beats on the
scrub bar.
Acceptance: on a track with an obvious drop, the largest movement lands on it,
and the beat markers line up with audible beats.

### Phase 6 — Polish
Goal: production feel.
Tasks: foot-contact IK to kill foot sliding; optional character/scene selection;
shareable result links; caching of repeated songs.
Acceptance: feet stay planted during contact frames; a result is shareable by
URL.

---

## 11. Risk register

- Rest-pose alignment and axis convention (section 9) will eat most debugging
  time. Budget for it, validate one static frame first.
- SMPL/EDGE licensing and download gating can block Phase 0. Resolve access
  before estimating timelines.
- GPU cost and cold starts on Modal. Cache the loaded model between requests;
  do not reload weights per job.
- Rotation representation mismatch (axis-angle vs 6D) between what EDGE emits and
  what your FK assumes. Normalize once, in `contracts.py`.
- Foot sliding will look bad before Phase 6; that is expected, do not chase it
  early.

---

## 12. Conventions

- Code: TypeScript on the frontend, type hints on Python. Keep the model call
  behind one function so the generator is swappable. Small, named functions over
  large ones.
- Any prose you write (README, docs, comments, commit messages): American
  English, no em dashes, understated and direct. Prefer a clear recommendation
  over a list of options.
- Comment the non-obvious math (retarget, FK, coordinate fix) with the why, not
  the what.

---

## 13. First action

Confirm you have read this brief, then propose the concrete Phase 0 plan: the
Modal image definition, how you will obtain SMPL and the EDGE checkpoint, and the
exact command that will produce `fixtures/sample_motion.json`. Wait for my go
before running anything that needs the GPU.
