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
import { toMotionInput } from '../src/core/motionInput.ts';
import { createWasmCoreFromModule } from '../src/core/wasmCore.ts';
import createCoreFactory from '../src/core/generated/entrain_core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const glb = fs.readFileSync(path.join(repo, 'assets/character.glb'));
const motion = JSON.parse(fs.readFileSync(path.join(repo, 'backend/fixtures/sample_motion.json'), 'utf8'));
const wasmBinary = fs.readFileSync(path.join(here, '../src/core/generated/entrain_core.wasm'));

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
  const wasm = createWasmCoreFromModule(mod);
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
      const w = createWasmCoreFromModule(mod); w.setup(skeleton, mi, params); wc.push(w);
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
