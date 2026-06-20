# entrain

Music to 3D dance. Upload a song, a pretrained diffusion model generates a
dance, and a rigged character performs it in the browser in sync with the audio.
The performance-critical motion math runs in a hand-written C++ core compiled to
WebAssembly, with a pure-TypeScript implementation as the parity reference and
fallback.

## What it does

- Upload an audio file.
- The backend generates SMPL dance motion with EDGE on a Modal GPU.
- The motion is retargeted onto a Mixamo character in the browser and played
  back in sync with the audio, with play/pause/scrub and beat markers.
- Bring your own Mixamo character (glb or fbx), and download the result as a GLB
  with the animation baked in.
- A multi-dancer mode spawns a field of characters with live, per-dancer tuning,
  to exercise the motion core.

## Architecture

```
audio -> FastAPI job -> Modal GPU (EDGE) -> SMPL motion (frozen contract)
                                            -> retarget + cleanup (WASM core)
                                            -> Three.js playback (browser)
```

- Frontend: React + Vite + TypeScript + Three.js. Owns the scene, character
  loading, playback, transport, character upload, and GLB export. The numeric
  motion work is delegated to the WASM core.
- Motion core: a C++17 module compiled to WebAssembly (`cpp/`). Does forward
  kinematics, the SMPL-to-Mixamo rest-pose retarget, the coordinate fix, pelvis
  stabilization, grounding, and the foot-lock high-pass. The identical pure-TS
  implementation in `frontend/src/core/retargetCore.ts` is both the correctness
  oracle and the runtime fallback.
- Backend: FastAPI (`backend/app.py`) runs generation as an in-memory job; the
  frontend uploads and polls. Generation is EDGE on Modal (`backend/modal_app.py`),
  behind one swappable function (`backend/pipeline/generate.py`).
- Contract: `backend/pipeline/contracts.py` freezes the Motion shape (axis-angle
  SMPL poses, root translation, foot contact, audio beats).

## The motion core (C++/WASM)

The retarget and cleanup math was ported from TypeScript to C++ for speed, with
a clean boundary: strings, loading, and rendering stay in JS; JS resolves bone
names to integer indices once and hands the core only indices and flat typed
arrays, passed zero-copy through the WASM heap. The two implementations share
one interface (`setup` / `compute_all` / `compute_frame` / `set_params`), so the
WASM core is the default and the TS oracle takes over automatically if the
module fails to load.

Correctness is gated by a parity test (`frontend/tests/parity.test.ts`): the
WASM core must match the TS oracle on a committed golden fixture to within
1e-4 rad per bone and ~1e-5 m on the root. Measured agreement is ~1.6e-6 rad.

Measured speedup over the TS path (see `docs/BENCHMARK.md` for method):

| workload                         | TS oracle | WASM core | speedup |
| -------------------------------- | --------- | --------- | ------- |
| full-clip retarget (120 frames)  | ~3.3 ms   | ~0.4 ms   | ~8x     |
| per frame                        | ~12 us    | ~1 us     | ~11x    |
| pose 250 dancers / render frame  | ~3.2 ms   | ~0.29 ms  | ~11x    |

At 250 dancers the motion math is under 2% of a 60 FPS frame budget on WASM
versus ~19% on TS. The win is compiled C++, zero-copy heap I/O, and batching, not
SIMD: `-msimd128` measured within noise, since quaternion math is dependency
tight (documented honestly in `docs/BENCHMARK.md`).

## Quick start

Prerequisites: Node 18+, Python 3.10+ with a venv, and Emscripten + CMake for the
WASM core (pinned versions and setup in `docs/SETUP.md`). Real generation also
needs a Modal account and the gated assets (`docs/SETUP.md`).

Frontend (the WASM core builds automatically via `predev` / `build`):

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

Open the Vite URL and upload a song. The panel on the right controls the dancer
count and live tuning.

## Tests and benchmark

```
npm --prefix frontend run test        # WASM vs TS oracle parity (Vitest)
npm --prefix frontend run bench        # WASM vs TS performance numbers
npm --prefix frontend run gen:parity   # regenerate the golden fixture
```

## Repo layout

```
cpp/
  math.hpp          hand-rolled quat/vec3 (matches Three.js formulas)
  retarget.cpp      FK + coordinate fix + rest-pose correction + stabilization
  cleanup.cpp       grounding + foot-lock + position FK
  api.cpp           exported handle-based setup / compute_all / compute_frame
  build.sh          emcmake build, copies the module into the frontend
frontend/src/
  App.tsx           upload, poll, transport, character/download/tuning UI
  Viewer.tsx        Three scene, multi-dancer field, GLB export
  retarget.ts       bone-name resolution + buildSkeleton + default params
  core/
    retargetCore.ts pure-TS motion core (oracle + fallback)
    wasm.ts         loads the WASM module, zero-copy heap I/O
  api.ts            jobs API client
frontend/tests/     parity harness + fixtures
backend/
  app.py            FastAPI: POST /jobs, GET /jobs/{id}
  modal_app.py      Modal GPU image + cached EDGE Generator
  pipeline/         contracts.py, generate.py, audio.py
  fixtures/         committed stand-in motion + its generator
reference/          smpl_to_mixamo_retarget.js (retarget reference)
docs/               SETUP.md (assets + toolchain), BENCHMARK.md
assets/character.glb  the default Mixamo character
```

## Notes

- These empirical constants were tuned by hand against real EDGE clips and are
  reproduced exactly by both cores: the coordinate fix is +90 degrees about Z
  (real EDGE motion is not plain Z-up), the pelvis keeps yaw but zeroes pitch and
  roll to remove EDGE's lean, and the planted foot is locked and high-passed so
  the dancer does not slide or drift.
- Generation covers the whole song; `out_length` is capped to EDGE's slice count.

## License

Research and portfolio use only. The SMPL body model and the EDGE checkpoint are
non-commercial research licenses. Do not ship commercially or redistribute their
weights. The Mixamo character is free to use.
