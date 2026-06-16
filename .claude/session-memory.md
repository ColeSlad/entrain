# Session Memory
**Last checkpoint:** 2026-06-15T00:00:00Z
**Project:** entrain — /Users/colesladowsky/Desktop/Projects/entrain

## What we're working on
Built a music-to-3D-dance web app end to end: upload a song, EDGE generates SMPL
dance motion on a Modal GPU, it's retargeted onto a Mixamo character in the
browser and played in sync with the audio. The whole brief plus extras is now
done (full-song generation, model caching, beat markers, foot grounding +
locking, bring-your-own glb/fbx character, GLB download). Just finished a README
+ cleanup pass. The only major remaining item is hosted deployment (currently
localhost). The user commits to git themselves with conventional-prefix messages
I supply, one logical change at a time; I never commit.

## Key decisions made
- **COORD_FIX = +90 deg about Z** (`frontend/src/retarget.ts`, `_coordFix`): found by a live keyboard tuner, NOT the reference's -90 about X. Real EDGE motion is not the plain Z-up the reference assumed. Verified by analyzing a real clip's root rotation with scipy.
- **Pelvis stabilization for the lean** (`retarget.ts` `stabilizeUpright` + `ROOT_UPRIGHT`, applied to the root bone inside `applyFrame`): EDGE's pelvis carries ~30 deg pitch + ~25 deg constant recline. Keep yaw, zero pitch/roll on the Hips local rotation (the lean lives there). Alternative considered: removing it in `smplAnimGlobals` — wrong, a uniform world rotation cancels in the relative localization.
- **Foot-locking with high-pass recenter** (`Viewer.tsx` `computeRootPath`, `FOOT_LOCK`, `RECENTER_WIN=61`): lock the lower foot horizontally to kill sliding; subtract a slow moving average so the body doesn't wander off. Tried plain root translation first — reverted (wrong vertical axis made floating worse).
- **Grounding** (`Viewer.tsx` `groundToFeet`): clamp lowest foot to floor each frame instead of true foot IK (EDGE pkl omits contacts, so `foot_contact` is zero-filled).
- **Model caching in-process** (`backend/modal_app.py` `Generator.load` @modal.enter + `_generate_cached`): replicate EDGE test.py's flow with the preloaded model; ~64s -> ~20s warm. Falls back to subprocess `pipeline.generate.generate_motion` on any error so it can't break.
- **out_length capped to EDGE slices** (`backend/pipeline/generate.py`): `slices=int((dur-5)/2.5)+1; out_length=int(slices*2.5)`. Overshooting hits EDGE's empty-randrange bug in test.py line 81.
- **Generator behind one swappable function** gated by `ENTRAIN_MODAL_GENERATE` (`app.py`) and `EDGE_DIR` (`generate.py`): real EDGE on Modal vs local fixture stand-in.
- **Audio is the master clock; play once + stop** (`App.tsx`): dance frame = audio.currentTime; no hard loop (popped at the seam).
- **EDGE image fixes**: `TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1` (accelerate dragged torch to 2.6), `scipy.signal.hann` shim (old librosa), Jukebox cache volume mounted at `/root/.cache/jukemirlib` (hardcoded path, no env override).

## Critical file paths
- `/Users/colesladowsky/Desktop/Projects/entrain/frontend/src/retarget.ts` — SMPL->Mixamo retarget: bone map, coreName normalization, FK, COORD_FIX, rest-pose correction, pelvis stabilization.
- `/Users/colesladowsky/Desktop/Projects/entrain/frontend/src/Viewer.tsx` — Three scene, character load (GLTFLoader/FBXLoader), per-frame pose, grounding, foot-locking precompute, GLB export (exportGLB via forwardRef/useImperativeHandle).
- `/Users/colesladowsky/Desktop/Projects/entrain/frontend/src/App.tsx` — upload/poll, audio master clock, character upload (glb/fbx, characterFbx), download button.
- `/Users/colesladowsky/Desktop/Projects/entrain/frontend/src/Transport.tsx` — play/pause/scrub + beat tick markers.
- `/Users/colesladowsky/Desktop/Projects/entrain/frontend/src/api.ts` — jobs client, Motion + AudioInfo types.
- `/Users/colesladowsky/Desktop/Projects/entrain/backend/app.py` — FastAPI POST/GET /jobs, ENTRAIN_MODAL_GENERATE gate.
- `/Users/colesladowsky/Desktop/Projects/entrain/backend/modal_app.py` — Modal image + cached Generator.
- `/Users/colesladowsky/Desktop/Projects/entrain/backend/pipeline/generate.py` — generate_motion: EDGE subprocess + beat analysis + out_length cap.
- `/Users/colesladowsky/Desktop/Projects/entrain/backend/pipeline/contracts.py` — Motion/Audio dataclasses, validation.
- `/Users/colesladowsky/Desktop/Projects/entrain/README.md` — just written; docs/SETUP.md for gated assets.

## Current blockers / open questions
- None blocking. The README + cleanup change (added README.md; removed backend/fixtures/edge_sample.json and frontend/public/sample_motion.json symlink) is UNCOMMITTED — the user still needs to commit it with the message I supplied.
- Real generation requires the user's Modal deploy + ENTRAIN_MODAL_GENERATE=1; the EDGE checkpoint is on the entrain-assets Modal volume.

## Specific next action
If continuing: deploy it — host the FastAPI app on Modal via @modal.asgi_app alongside the GPU Generator, build the frontend static and point its `API` const (in `frontend/src/api.ts`) at the Modal URL, and handle CORS for the hosted origin. Otherwise the project is complete and the user just needs to commit the README/cleanup change.