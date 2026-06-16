# entrain

Music to 3D dance. Upload a song, a pretrained model generates a dance, and a
rigged character performs it in the browser with synced audio and transport
controls.

## What it does

- Upload an audio file.
- The backend generates SMPL dance motion with EDGE on a Modal GPU.
- The motion is retargeted onto a Mixamo character in the browser and played
  back in sync with the audio, with play/pause/scrub and beat markers.
- You can bring your own Mixamo character (glb or fbx) and download the result
  as a GLB with the animation baked in.

## Architecture

```
audio -> FastAPI job -> Modal GPU (EDGE) -> SMPL motion (contract)
                                            -> retarget to Mixamo (browser)
                                            -> Three.js playback
```

- Frontend: React + Vite + TypeScript + Three.js. Retargets SMPL motion onto the
  character in the browser (no server-side GLB baking), and handles playback,
  transport, beat markers, character upload, and GLB export.
- Backend: FastAPI (`backend/app.py`) runs generation as an in-memory job; the
  frontend uploads and polls. Generation is EDGE on Modal (`backend/modal_app.py`),
  behind one swappable function (`backend/pipeline/generate.py`).
- Contract: `backend/pipeline/contracts.py` freezes the Motion shape (axis-angle
  SMPL poses, root translation, foot contact, audio beats).

## Status

The full pipeline works end to end: upload a song, get a full-length dance
generated on a GPU, retargeted and playing in sync. Beat markers, foot grounding
and locking, custom characters, and GLB download are in. Not done: hosted
deployment (still localhost) and All-In-One section labels.

## Quick start

Prerequisites: Python 3.10+ with a venv, Node 18+. Real generation also needs a
Modal account and the gated assets (see `docs/SETUP.md`).

Frontend:

```
npm --prefix frontend install
npm --prefix frontend run dev
```

Backend, two modes:

```
# Local stand-in (no GPU): every upload returns the committed fixture.
.venv/bin/uvicorn --app-dir backend app:app --reload --port 8000

# Real EDGE on Modal: deploy once, then run with the gate on.
cd backend && modal deploy modal_app.py
cd backend && ENTRAIN_MODAL_GENERATE=1 ../.venv/bin/uvicorn app:app --reload --port 8000
```

Open the Vite URL and upload a song.

## Repo layout

```
backend/
  app.py            FastAPI: POST /jobs, GET /jobs/{id}
  modal_app.py      Modal GPU image + cached EDGE Generator
  pipeline/
    contracts.py    Motion data contract
    generate.py     generate_motion: EDGE wrapper / local stand-in
    audio.py        audio feature interface (EDGE)
  fixtures/         committed stand-in motion + its generator
frontend/src/
  App.tsx           upload, poll, transport, character and download UI
  Viewer.tsx        Three scene, retarget playback, foot-locking, GLB export
  retarget.ts       SMPL to Mixamo retarget (coordinate fix, rest-pose correction)
  Transport.tsx     play/pause/scrub + beat markers
  api.ts            jobs API client
reference/          smpl_to_mixamo_retarget.js (retarget reference)
docs/SETUP.md       how to obtain the gated assets
assets/character.glb  the default Mixamo character
```

## Notes

- Real EDGE motion is Z-up; the browser retarget applies a coordinate fix (+90
  about Z) to stand it upright (`retarget.ts`).
- The pelvis is held upright and the planted foot is locked to the floor in the
  viewer to reduce EDGE's lean and foot sliding.
- Generation covers the whole song; `out_length` is capped to EDGE's slice count.

## License

Research and portfolio use only. The SMPL body model and the EDGE checkpoint are
non-commercial research licenses. Do not ship commercially or redistribute their
weights. The Mixamo character is free to use.
