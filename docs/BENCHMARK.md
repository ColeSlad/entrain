# Benchmark: WASM motion core vs TS oracle

## Slider responsiveness (September 7, 2026)

The viewer now runs motion computation in one Web Worker. Count changes keep
existing clones and add/remove the difference in approximately 4 ms batches.
Tuning uses existing cores and shared immutable input buffers; newer values
supersede pending updates. Foot-lock strength does not rebuild the path, and
recenter changes reuse the smoothed path. Matching vertices in the default rig
are indexed once on load (147,336 vertices become 28,374; triangle count and
skinning attributes are preserved).

A local production-build browser check used Chrome with the Apple M3 Max Metal
renderer, a 1100×750 viewport at 1× DPR, and a two-minute motion made by repeating
the committed fixture. It changed dancer count, variation, upright, foot lock,
and recenter during playback. Measured animation-frame intervals:

| Dancers | 95th-percentile frame interval | Main-thread tasks over 50 ms |
| ------- | ----------------------------- | ---------------------------- |
| 25      | 16.8 ms                       | 0                            |
| 100     | 16.8 ms                       | 0                            |
| 250     | 16.7 ms                       | 0                            |
| 400     | 16.7 ms                       | 0                            |

This checks rendering/input responsiveness while tuning completes incrementally
in the worker; it does not measure the time until every dancer has adopted a new
setting. Browser automation round trips for tuning inputs were at most 10 ms
through 250 dancers and 95 ms at 400. Rapid count reversals while paused and GLB
export also succeeded, with no browser errors or WASM fallback. These are local
hardware results, not a guarantee for other GPUs, rigs, or browser configurations.

The following core-only measurements predate the worker integration and exclude
rendering and worker messaging.

The motion math (SMPL forward kinematics, the rest-pose retarget, the coordinate
fix, pelvis stabilization, grounding, and the foot-lock high-pass) runs in two
interchangeable implementations: a C++ core compiled to WebAssembly (the default
path) and a pure TypeScript oracle (the fallback and the parity reference). This
measures the two on the same input.

## Headline

On the committed fixture, the WASM core is about **8x faster** than the TS oracle
for a full-clip retarget and about **11x faster** per frame. Per-frame compute is
roughly **1 microsecond**, so a single dancer uses about 0.006% of a 60 FPS frame
budget and the core could drive thousands of dancers before the math became the
bottleneck.

## Method

- Fixture: the real Mixamo skeleton from `assets/character.glb` (69 nodes, 22
  mapped SMPL bones) and the committed motion `backend/fixtures/sample_motion.json`
  (120 frames at 30 FPS). Both cores get identical typed-array input.
- Warm up, then take the median of many iterations (60 for the full clip, 5000
  per frame). Script: `frontend/scripts/benchmark.mjs`, run with `npm run bench`.
- Run under Node's V8, the same engine Chrome uses, so the ratios track the
  browser closely. Absolute numbers vary by machine; the speedup factor is the
  stable, portable result. Measured on an Apple M-series laptop.
- Parity is enforced separately (`npm test`): WASM matches the oracle within
  1.6e-6 rad per bone and 1.3e-5 m on the root, so this compares two
  implementations of the same result, not two different results.

## Results

Full clip (setup + computeAll, the whole pipeline over all 120 frames), median:

| implementation | time     | speedup |
| -------------- | -------- | ------- |
| TS oracle      | ~3.35 ms | 1x      |
| WASM core      | ~0.41 ms | ~8.2x   |

Per frame (computeFrame, one frame reposed for scrub), median:

| implementation | time      | speedup |
| -------------- | --------- | ------- |
| TS oracle      | ~0.012 ms | 1x      |
| WASM core      | ~0.001 ms | ~11x    |

Frame budget at 60 FPS is 16.7 ms. Dividing by the per-frame cost, the math alone
would fit on the order of 15,000 WASM dancers or 1,400 TS dancers in one frame.
That is a ceiling for the retarget math, not a rendering claim; Three.js drawing
and skinning dominate long before then. The point is that the motion core is no
longer the limit.

Multi-dancer field (the metric the integration changed for the app): time to
pose K dancers for one render frame, K independent cores each calling
computeFrame, median:

| dancers | TS oracle | WASM core | speedup |
| ------- | --------- | --------- | ------- |
| 25      | ~0.33 ms  | ~0.03 ms  | ~11.6x  |
| 100     | ~1.29 ms  | ~0.11 ms  | ~11.3x  |
| 250     | ~3.22 ms  | ~0.29 ms  | ~11.2x  |

Cost scales linearly with K, as expected. At 250 dancers the field math is about
0.29 ms/frame on WASM versus 3.22 ms on TS, so WASM spends under 2% of the frame
budget where the TS path already spends ~19%. Past a few hundred dancers the
bottleneck is Three.js skinned rendering, not the core, on either path.

## SIMD

The release build uses `-O3 -msimd128`. Measured with and without `-msimd128`,
the difference was within run-to-run noise (both ~0.3 to 0.4 ms for the full
clip). Quaternion multiplication is four wide but dependency tight, so the
autovectorizer has little to exploit, and hand-written SIMD intrinsics were not
pursued: they would add complexity and parity risk for no measurable gain.

The speedup is not from SIMD. It comes from:

- Compiled C++ instead of interpreted/JIT JavaScript with per-quaternion object
  allocation.
- Bulk typed-array I/O: inputs are written into the WASM heap and outputs are
  copied through `HEAPF32` views, avoiding per-bone API calls. The current viewer
  additionally shares immutable input allocations across dancer handles.
- Batching: `compute_all` runs the entire clip in one call across the boundary,
  so the crossing cost is amortized over all frames.

## Reproduce

```
npm --prefix frontend run build:wasm   # build the WASM module
npm --prefix frontend run bench         # print the table above
```

To confirm the in-browser numbers match (same V8), the same two cores are what
the app already loads (`createWasmCore` with the `createTsCore` fallback); timing
`computeAll` around a clip load in the running app reproduces these ratios.
