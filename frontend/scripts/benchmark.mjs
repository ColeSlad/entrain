// Benchmark the WASM motion core against the TS oracle on the real skeleton and
// the committed motion fixture. Two measurements (brief section 7):
//   1. Full-clip: setup + computeAll (FK + retarget + cleanup over all frames).
//   2. Per-frame: computeFrame, vs the 16.7ms/60fps budget, scaled by K dancers.
// Warm up, run many iterations, report the median.
//
// Measured under Node's V8, the same engine Chrome uses, so the ratios track the
// browser closely; absolute numbers vary by machine. Run: npm run bench.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildSkeleton, defaultParams } from '../src/retarget.ts';
import { createTsCore } from '../src/core/retargetCore.ts';
import createCoreFactory from '../src/core/generated/entrain_core.js';

// Minimal WASM MotionCore for the benchmark, mirroring src/core/wasm.ts (which
// imports the module through the Vite "entrain-core" alias that raw Node cannot
// resolve). The parity test exercises the real wrapper; this only times compute.
// One module is shared across cores via handles, exactly as the app does, so the
// multi-dancer measurement reflects real per-handle (not per-module) cost.
function wasmCore(mod) {
  const cw = (n, r, a) => mod.cwrap(n, r, Array.from({ length: a }, () => 'number'));
  const _create = cw('core_create', 'number', 0);
  const _setup = cw('setup', null, 15), _sp = cw('set_params', null, 8);
  const _ca = cw('compute_all', null, 1), _cf = cw('compute_frame', null, 2);
  const _gol = cw('get_out_local_quat', 'number', 1), _gor = cw('get_out_root_pos', 'number', 1);
  const _gfl = cw('get_frame_local_quat', 'number', 1), _gfr = cw('get_frame_root_pos', 'number', 1);
  const _free = cw('core_free', null, 1);
  const h = _create();
  let ptrs = [], nB = 0, nF = 0;
  const wf = (a) => { const p = mod._malloc(Math.max(4, a.length * 4)); mod.HEAPF32.set(a, p >> 2); ptrs.push(p); return p; };
  const wi = (a) => { const p = mod._malloc(Math.max(4, a.length * 4)); mod.HEAP32.set(a, p >> 2); ptrs.push(p); return p; };
  const freeP = () => { for (const p of ptrs) mod._free(p); ptrs = []; };
  return {
    setup(s, m, pr) {
      freeP(); nB = s.numBones; nF = m.numFrames;
      const pa = wi(s.parentIndex), rq = wf(s.restLocalQuat), rp = wf(s.restLocalPos), s2 = wi(s.smplToTarget), fb = wi(s.footBones);
      const pp = wf(m.smplPoses), pt = wf(m.rootTranslation), pc = wf(m.footContact);
      _setup(h, nB, pa, rq, rp, s2, fb, s.footBones.length, s.lockFeet[0], s.lockFeet[1], nF, m.fps, pp, pt, pc);
      const cf = pr.coordFix;
      _sp(h, pr.rootUpright, pr.footLock, pr.recenterWin, cf[0], cf[1], cf[2], cf[3]);
    },
    computeAll() { _ca(h); const q = _gol(h) >> 2, r = _gor(h) >> 2; return { localQuat: mod.HEAPF32.slice(q, q + nF * nB * 4), rootPos: mod.HEAPF32.slice(r, r + nF * 3) }; },
    computeFrame(f, oq, or_) { _cf(h, f); const q = _gfl(h) >> 2, r = _gfr(h) >> 2; oq.set(mod.HEAPF32.subarray(q, q + nB * 4)); or_.set(mod.HEAPF32.subarray(r, r + 3)); },
    free() { _free(h); freeP(); },
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const glb = fs.readFileSync(path.join(repo, 'assets/character.glb'));
const motion = JSON.parse(fs.readFileSync(path.join(repo, 'backend/fixtures/sample_motion.json'), 'utf8'));
const wasmBinary = fs.readFileSync(path.join(here, '../src/core/generated/entrain_core.wasm'));

function toMotionInput(m) {
  const N = m.num_frames;
  const smplPoses = new Float32Array(N * 72);
  const rootTranslation = new Float32Array(N * 3);
  const footContact = new Float32Array(N * 4);
  for (let f = 0; f < N; f++) {
    for (let k = 0; k < 72; k++) smplPoses[f * 72 + k] = m.smpl_poses[f][k];
    const t = m.root_translation[f];
    rootTranslation[f * 3] = t[0]; rootTranslation[f * 3 + 1] = t[1]; rootTranslation[f * 3 + 2] = t[2];
    const c = m.foot_contact?.[f];
    if (c) for (let k = 0; k < 4; k++) footContact[f * 4 + k] = c[k];
  }
  return { fps: m.fps, numFrames: N, smplPoses, rootTranslation, footContact };
}

const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
function bench(fn, iters, warmup) {
  for (let i = 0; i < warmup; i++) fn();
  const t = [];
  for (let i = 0; i < iters; i++) { const s = performance.now(); fn(); t.push(performance.now() - s); }
  return median(t);
}

const loader = new GLTFLoader();
const ab = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
loader.parse(ab, '', async (gltf) => {
  const { skeleton } = buildSkeleton(gltf.scene);
  const N = motion.num_frames;
  const params = defaultParams();
  const mi = toMotionInput(motion);

  const mod = await createCoreFactory({ wasmBinary });
  const ts = createTsCore();
  const wasm = wasmCore(mod);
  const outQ = new Float32Array(skeleton.numBones * 4);
  const outR = new Float32Array(3);

  // 1. Full clip: setup + computeAll.
  const tsClip = bench(() => { ts.setup(skeleton, mi, params); ts.computeAll(); }, 60, 5);
  const wasmClip = bench(() => { wasm.setup(skeleton, mi, params); wasm.computeAll(); }, 60, 5);

  // 2. Per frame: computeFrame on a fixed frame (setup once first).
  ts.setup(skeleton, mi, params);
  wasm.setup(skeleton, mi, params);
  const f = (N / 2) | 0;
  const tsFrame = bench(() => ts.computeFrame(f, outQ, outR), 5000, 500);
  const wasmFrame = bench(() => wasm.computeFrame(f, outQ, outR), 5000, 500);
  wasm.free();

  const fps = (ms) => Math.round(N / (ms / 1000));
  const r = (x) => x.toFixed(3);
  console.log(`\nfixture: ${N} frames, ${skeleton.numBones} bones, ${skeleton.numBones * N * 4} output floats\n`);
  console.log('full clip (setup + computeAll), median:');
  console.log(`  TS oracle : ${r(tsClip)} ms   (${fps(tsClip)} clip-fps)`);
  console.log(`  WASM      : ${r(wasmClip)} ms   (${fps(wasmClip)} clip-fps)`);
  console.log(`  speedup   : ${(tsClip / wasmClip).toFixed(2)}x\n`);
  console.log('per frame (computeFrame), median:');
  console.log(`  TS oracle : ${r(tsFrame)} ms`);
  console.log(`  WASM      : ${r(wasmFrame)} ms`);
  console.log(`  speedup   : ${(tsFrame / wasmFrame).toFixed(2)}x`);
  console.log(`  16.7ms/60fps budget: WASM fits ${Math.floor(16.7 / wasmFrame)} dancers, TS fits ${Math.floor(16.7 / tsFrame)}\n`);

  // 3. Multi-dancer field: pose K dancers for one render frame (K computeFrame
  //    calls), WASM vs TS. This is the per-render-frame motion cost during
  //    playback, and the metric the C++ integration changed for the app.
  console.log('multi-dancer field (pose K dancers per render frame), median:');
  console.log('     K |   WASM ms |     TS ms |  speedup');
  for (const K of [1, 25, 100, 250]) {
    const wc = [], tc = [];
    for (let i = 0; i < K; i++) {
      const w = wasmCore(mod); w.setup(skeleton, mi, params); wc.push(w);
      const t = createTsCore(); t.setup(skeleton, mi, params); tc.push(t);
    }
    const wField = bench(() => { for (const c of wc) c.computeFrame(f, outQ, outR); }, 120, 12);
    const tField = bench(() => { for (const c of tc) c.computeFrame(f, outQ, outR); }, 120, 12);
    for (const c of wc) c.free();
    console.log(`  ${String(K).padStart(4)} | ${r(wField).padStart(9)} | ${r(tField).padStart(9)} | ${(tField / wField).toFixed(2).padStart(6)}x`);
  }
  console.log('\n  per-frame field cost scales linearly with K; beyond a few hundred dancers');
  console.log('  the limit is Three.js skinned rendering, not the motion core.\n');
}, (err) => { console.error('GLB parse failed:', err?.message || err); process.exit(1); });
