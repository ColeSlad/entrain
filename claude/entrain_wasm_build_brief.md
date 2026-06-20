# Build Brief: Entrain C++/WASM Motion Core

You are helping me port the performance-critical motion math in Entrain (a
music-to-3D-dance web app) from TypeScript into a C++ core compiled to
WebAssembly. Entrain already works end to end. This is an optimization and a
depth pass, not a rewrite. Read this whole document before writing code. Where
it conflicts with an assumption you would otherwise make, this document wins.

---

## 0. Context: what already exists

The app is React + Vite + TypeScript + Three.js on the frontend, FastAPI +
Modal on the backend, and a pretrained EDGE diffusion model that emits SMPL
dance motion. The frozen data contract is:

```
Motion {
  fps, num_frames,
  smpl_poses:       [num_frames][72]   // 24 joints x 3, axis-angle, LOCAL
  root_translation: [num_frames][3]    // pelvis, meters
  foot_contact:     [num_frames][4]    // 0/1 (currently zero-filled)
  audio:            { bpm, beats[], downbeats[], sections[] } | null
}
```

All the math we are porting currently lives on the frontend in `retarget.ts`
(SMPL to Mixamo retargeting) and inside `Viewer.tsx` (the motion cleanup
passes). The Three.js scene, character loading, rendering, GLB export, and bone
name resolution stay in JavaScript. Only the numeric work moves.

These empirically-tuned values were found by hand against real EDGE clips and
must be reproduced EXACTLY by the C++ port, not re-derived:
- Coordinate fix: +90 degrees about Z to bring the body upright in Y-up.
- Pelvis stabilization: keep the Hips yaw, zero its pitch and roll (`ROOT_UPRIGHT`).
- Foot-lock high-pass window (`RECENTER_WIN`) and the `FOOT_LOCK` behavior.
If your port changes the look of the output, the port is wrong, even if the math
seems more correct. The TS output is the reference.

---

## 1. Goal and definition of done

Move the per-frame and per-clip motion math into a C++/WASM module that the
frontend calls, producing output that matches the current TypeScript within
float tolerance, then benchmark the two so I have a measured speedup.

Done means:
- The character dances identically to today, driven by the WASM core.
- A parity test proves WASM output matches the TS oracle within tolerance on the
  committed fixture.
- The TS implementation still exists as a fallback and is used automatically if
  the WASM module fails to load.
- A documented benchmark reports the WASM vs TS speedup for full-clip retarget
  and for per-frame cost.

Non-goals: no changes to the backend, the generator, the data contract, or the
visual result. No new model. No server-side WASM.

---

## 2. The boundary: what is C++ and what stays JS

Keep this split clean. It is the most important design decision here.

Stays in JavaScript:
- Three.js scene, character load (GLTFLoader / FBXLoader), render loop, orbit,
  GLB export, transport UI, audio clock.
- Bone NAME resolution. JS owns the loaded skeleton and knows the bone names,
  including the `mixamorig:Hips` vs `mixamorig_Hips` normalization. JS resolves
  names to integer bone indices once and hands C++ only indices.

Moves to C++/WASM:
- Forward kinematics over the SMPL tree (local axis-angle to global rotations).
- The rest-pose retarget correction.
- The coordinate fix.
- Pelvis stabilization, grounding, and the foot-lock path (these need
  world-space joint positions, so the core computes target-skeleton FK too).

Rule of thumb: strings, loading, and rendering stay in JS; anything that is a
tight loop over frames and joints goes to C++.

---

## 3. The WASM call contract

C++ works in indices and flat typed arrays. No strings cross the boundary. Bulk
arrays are passed zero-copy through the WASM heap (JS writes into a `_malloc`ed
region, reads results back through `HEAPF32` views). Design the exported API
around three calls.

`setup(skeleton, motion, params)` once per character load:
- Skeleton (resolved by JS from the loaded rig, in REST pose):
  - `num_bones`
  - `parent_index[num_bones]` (int, -1 for root)
  - `rest_local_quat[num_bones * 4]` (xyzw)
  - `rest_local_pos[num_bones * 3]`
  - `smpl_to_target[24]` (int, target bone index for each SMPL joint, -1 if
    unmapped) computed in JS from the bone map including the collar/shoulder and
    ankle/foot offsets.
- Motion: `num_frames`, `fps`, `smpl_poses[num_frames*72]`,
  `root_translation[num_frames*3]`, `foot_contact[num_frames*4]`.
- Params: the empirical constants above, passed explicitly so they are tunable
  from JS (`ROOT_UPRIGHT`, `FOOT_LOCK`, `RECENTER_WIN`, and the coordinate fix
  quaternion) rather than hardcoded in C++.

`compute_all()`:
- Runs the full pipeline over every frame and writes into heap output buffers:
  - `out_local_quat[num_frames * num_bones * 4]` (target bone LOCAL rotations)
  - `out_root_pos[num_frames * 3]` (grounded + foot-locked root position)
- Returns pointers/offsets so JS can build `HEAPF32` views with no copy.

`compute_frame(i)`:
- Same math for a single frame index, for scrub and live param changes. Used
  when a tunable changes so we do not recompute the whole clip unless needed.

Also expose `set_params(...)` and `free()` for cleanup. SMPL's rest pose is
all-identity, so its rest globals are identity and the source side of the
retarget simplifies; keep that simplification.

The render loop should NOT call into WASM per frame in the common case. Call
`compute_all` on character load into the output buffer, then the JS render loop
just indexes into the buffer and applies quaternions to bones. `compute_frame`
exists for scrub-with-changed-params and for the per-frame benchmark.

---

## 4. Toolchain

- Emscripten (emsdk). Pin the version in `docs/SETUP.md`.
- Hand-roll a tiny `quat`/`vec3` math header (multiply, inverse, normalize,
  from-axis-angle, the yaw/pitch/roll decomposition for pelvis stabilization).
  It is a small, dependency-free set and it is the point of the exercise. Do not
  pull in a large math library; glm is acceptable only if you hit a wall.
- Build with CMake via `emcmake cmake`. A Makefile is acceptable if CMake fights
  you, but document whichever you choose.
- Output an ES6 module Vite can import:
  `-sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web -sALLOW_MEMORY_GROWTH=1`.
- Release build: `-O3 -msimd128`. Debug build: `-O0 -g -sASSERTIONS=1` with
  source maps.
- Export what JS needs: the functions above plus
  `-sEXPORTED_RUNTIME_METHODS=['ccall','cwrap','HEAPF32']` and `_malloc`/`_free`.
- Make the WASM build a Vite build step so `npm run build` produces it; do not
  commit the `.wasm` artifact, commit the source and the build script.

---

## 5. Repo additions

```
cpp/
  CMakeLists.txt
  math.hpp           hand-rolled quat/vec3
  retarget.cpp       FK + rest-pose correction + coordinate fix
  cleanup.cpp        grounding, pelvis stabilization, foot-lock
  api.cpp            exported setup / compute_all / compute_frame / set_params
build/
  entrain_core.js    emitted ES6 module (gitignored)
  entrain_core.wasm  (gitignored)
frontend/src/
  core/
    wasm.ts          loads the module, malloc/free, HEAPF32 view helpers
    retargetCore.ts  pure TS oracle + fallback (see Phase 1)
  Viewer.tsx         now consumes the output buffer instead of computing inline
tests/
  parity.test.ts     WASM vs TS oracle on the fixture
docs/
  SETUP.md           emsdk + build instructions
  BENCHMARK.md       the measured numbers
```

---

## 6. Phases (parity-gate every one)

### Phase 0 — Toolchain scaffold
Stand up emsdk + CMake + the Vite integration. Export a trivial `add(a,b)` and
call it from a throwaway component. Acceptance: `npm run dev` and `npm run build`
both load the module and the JS gets the right number back.

### Phase 1 — Pure TS oracle (no C++ yet)
Refactor the existing math out of `Viewer.tsx` and `retarget.ts` into
`core/retargetCore.ts` as pure functions over plain typed arrays, matching the
exact signature WASM will use (the section 3 inputs and outputs). No behavior
change. This becomes both the correctness oracle and the runtime fallback.
Acceptance: the app looks identical to before, with all math now flowing through
the pure module.

### Phase 2 — Port FK + retarget (rotations only)
Implement `math.hpp`, FK down the SMPL tree, the coordinate fix, and the
rest-pose correction in C++. Wire `setup` + `compute_all` for rotations only
(skip cleanup for now; pass through root translation unchanged).
Acceptance: `parity.test.ts` shows max per-bone angular error vs the TS oracle
under 1e-4 rad across all fixture frames.

### Phase 3 — Heap buffers + viewer swap
Finalize the zero-copy heap I/O and `HEAPF32` views in `wasm.ts`. Switch
`Viewer.tsx` to read bone rotations from the WASM output buffer. Add the
load-failure fallback to the TS oracle. Acceptance: character dances from the
WASM path; killing the WASM load falls back to TS with no visible difference;
parity still holds.

### Phase 4 — Port the cleanup passes
Implement grounding (lowest-foot Y clamp), pelvis stabilization (keep yaw, zero
pitch/roll on Hips local, via the yaw/pitch/roll decomposition), and foot-lock
(planted-foot horizontal fix, smoothed at handoffs, high-passed with
`RECENTER_WIN`). These need target-skeleton world-position FK, so compute it in
C++. Acceptance: the grounded, de-leaned, foot-locked result matches the current
viewer output within tolerance and is visually identical.

### Phase 5 — SIMD, layout, benchmark
Lay the per-frame data out structure-of-arrays for cache and vectorization,
build with `-msimd128`, and only hand-write SIMD intrinsics for the quaternion
multiply if the benchmark in section 7 shows it is worth it. Make WASM the
default with TS as fallback. Acceptance: `docs/BENCHMARK.md` has the numbers,
parity holds, fallback works.

### Phase 6 — Optional: prove it matters
Add a multi-dancer mode (K characters sharing the core) and expose the tunables
(`ROOT_UPRIGHT`, `FOOT_LOCK`, `RECENTER_WIN`) through `set_params` so live tuning
recomputes via `compute_frame`/`compute_all`. This is what makes the perf win
real rather than academic.

---

## 7. Benchmark spec (this produces the resume number)

Measure in the browser, since WASM performance depends on the JS engine. Use
`performance.now()`, warm up, run many iterations, report the median.

Measure two things, WASM vs the TS oracle, on the same fixture:
1. Full-clip throughput: time to run the complete pipeline (FK + retarget +
   cleanup) over all `num_frames`. Report ms and frames-per-second of compute.
2. Per-frame latency: time for `compute_frame` vs the TS per-frame path. Compare
   against the 16.7 ms budget at 60 FPS, and show how it scales with K dancers
   (K * num_bones).

Report the speedup factor and the frame-budget headroom in `docs/BENCHMARK.md`.
That factor is the number for the resume bullet. Be honest: if SIMD adds little
over scalar -O3 (quaternions are already 4-wide and dependency-tight), say so
and let the batching and zero-copy be the story.

---

## 8. Conventions

- C++: keep it small and readable, hand-rolled math, no heavy deps. Comment the
  why on the non-obvious parts (coordinate fix, rest-pose correction, the
  yaw/pitch/roll decomposition).
- TS: keep the oracle pure and side-effect free so it stays a valid reference.
- Any prose you write (README, docs, comments, commits): American English, no em
  dashes, understated and direct.
- Never delete the TS path. It is the oracle and the fallback.
- Preserve the empirical constants exactly; treat the current visual output as
  ground truth.

---

## 9. First action

Confirm you have read this brief, then propose the Phase 0 plan: the emsdk
version, the CMake plus Vite wiring, and the trivial export you will use to prove
interop. Do not start the math port until Phase 1 has extracted the pure TS
oracle, because the oracle is what every later phase is checked against.
