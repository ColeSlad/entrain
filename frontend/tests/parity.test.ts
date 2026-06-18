import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { createTsCore, type MotionCore, type MotionInput, type Skeleton } from '../src/core/retargetCore';
import { createWasmCore } from '../src/core/wasm';
import { defaultParams } from '../src/retarget';
import skeletonJson from './fixtures/skeleton.json';
import motionJson from './fixtures/motion.json';
import goldenJson from './fixtures/golden.json';

// The WASM module is built for the web (it fetches its .wasm relative to the
// glue). Under Node we hand it the bytes directly so it skips the fetch.
const wasmBinary = readFileSync(
  fileURLToPath(new URL('../src/core/generated/entrain_core.wasm', import.meta.url)),
);

// Parity harness. The fixture is the real character skeleton (from buildSkeleton)
// and the committed motion, with the oracle's output frozen as golden.json (see
// scripts/genParity.mjs). This guards the oracle against regressions like the
// coordinate-fix compounding bug, and the WASM core will be checked against the
// same golden once it lands (brief Phase 2 acceptance: under 1e-4 rad).

const skeleton: Skeleton = {
  numBones: skeletonJson.numBones,
  parentIndex: Int32Array.from(skeletonJson.parentIndex),
  restLocalQuat: Float32Array.from(skeletonJson.restLocalQuat),
  restLocalPos: Float32Array.from(skeletonJson.restLocalPos),
  smplToTarget: Int32Array.from(skeletonJson.smplToTarget),
  footBones: Int32Array.from(skeletonJson.footBones),
  lockFeet: Int32Array.from(skeletonJson.lockFeet),
};

function toMotionInput(m: typeof motionJson): MotionInput {
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

// Angular distance between two quaternions, in radians. Both are normalized
// first: the golden is stored rounded (hence slightly non-unit), and 2*acos
// near dot=1 is extremely sensitive to that, so skipping this would report
// rounding noise as a large angle.
function angle(ax: number, ay: number, az: number, aw: number, bx: number, by: number, bz: number, bw: number): number {
  const na = Math.hypot(ax, ay, az, aw), nb = Math.hypot(bx, by, bz, bw);
  const dot = Math.abs(ax * bx + ay * by + az * bz + aw * bw) / (na * nb);
  return 2 * Math.acos(Math.min(1, dot));
}

// Compare a core's output to the golden: max per-bone angular error (mapped
// bones) and max root-position error.
function errorVsGolden(out: { localQuat: Float32Array; rootPos: Float32Array }) {
  const { mapped, numFrames, localQuat: gq, rootPos: gr } = goldenJson;
  const n = skeleton.numBones;
  let maxAng = 0, maxPos = 0;
  for (let f = 0; f < numFrames; f++) {
    for (let mi = 0; mi < mapped.length; mi++) {
      const b = mapped[mi];
      const o = f * n * 4 + b * 4;
      const g = (f * mapped.length + mi) * 4;
      maxAng = Math.max(maxAng, angle(
        out.localQuat[o], out.localQuat[o + 1], out.localQuat[o + 2], out.localQuat[o + 3],
        gq[g], gq[g + 1], gq[g + 2], gq[g + 3],
      ));
    }
    for (let k = 0; k < 3; k++) maxPos = Math.max(maxPos, Math.abs(out.rootPos[f * 3 + k] - gr[f * 3 + k]));
  }
  return { maxAng, maxPos };
}

function run(core: MotionCore) {
  core.setup(skeleton, toMotionInput(motionJson), defaultParams());
  return core.computeAll();
}

describe('motion core parity', () => {
  it('TS oracle reproduces the golden fixture', () => {
    const { maxAng, maxPos } = errorVsGolden(run(createTsCore()));
    // Golden is rounded to 1e-6, so the oracle re-run matches to rounding noise.
    expect(maxAng).toBeLessThan(1e-4); // the brief's per-bone angular gate
    expect(maxPos).toBeLessThan(1e-5);
  });

  it('WASM core matches the oracle (rotations and grounded root position)', async () => {
    const core = await createWasmCore({ wasmBinary });
    const { maxAng, maxPos } = errorVsGolden(run(core));
    expect(maxAng).toBeLessThan(1e-4); // brief's per-bone angular gate
    expect(maxPos).toBeLessThan(1e-3); // grounded + foot-locked root (meters)
    core.free();
  });
});
