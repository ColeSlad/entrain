// Generate the parity fixture: run the REAL buildSkeleton on the committed
// character GLB and the oracle on the committed motion fixture, then write the
// inputs (skeleton, motion) and the oracle's output (golden) into
// tests/fixtures/. The parity test replays these so it never has to parse the
// 9MB GLB or depend on a DOM loader. Regenerate with `npm run gen:parity` after
// any intended change to buildSkeleton, the oracle, or the empirical params.
//
// Run via Node type-stripping: node --experimental-strip-types scripts/genParity.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildSkeleton, defaultParams } from '../src/retarget.ts';
import { createTsCore } from '../src/core/retargetCore.ts';
import { toMotionInput } from '../src/core/motionInput.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const outDir = path.resolve(here, '../tests/fixtures');
fs.mkdirSync(outDir, { recursive: true });

const glb = fs.readFileSync(path.join(repo, 'assets/character.glb'));
const motion = JSON.parse(fs.readFileSync(path.join(repo, 'backend/fixtures/sample_motion.json'), 'utf8'));

const ab = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
new GLTFLoader().parse(ab, '', (gltf) => {
  const built = buildSkeleton(gltf.scene);
  const sk = built.skeleton;
  console.log(`buildSkeleton: ${sk.numBones} nodes, mapped ${built.mappedCount} SMPL bones`);

  const params = defaultParams();
  const core = createTsCore();
  core.setup(sk, toMotionInput(motion), params);
  const out = core.computeAll();

  const N = motion.num_frames;
  const n = sk.numBones;
  const mapped = Array.from(new Set(Array.from(sk.smplToTarget).filter((b) => b >= 0)));
  // Golden: only the mapped bones' local rotations (the rest hold rest pose),
  // plus the root position. Rounded to keep the fixture small.
  const r = (x) => Math.round(x * 1e6) / 1e6;
  const goldenQuat = [];
  for (let f = 0; f < N; f++) {
    for (const b of mapped) {
      const o = f * n * 4 + b * 4;
      goldenQuat.push(r(out.localQuat[o]), r(out.localQuat[o + 1]), r(out.localQuat[o + 2]), r(out.localQuat[o + 3]));
    }
  }
  const goldenRoot = Array.from(out.rootPos, r);

  // Rest arrays are full precision: they are the core's input and must match
  // exactly what the golden was computed from (they round-trip through Float32).
  const skeletonJson = {
    numBones: sk.numBones,
    parentIndex: Array.from(sk.parentIndex),
    restLocalQuat: Array.from(sk.restLocalQuat),
    restLocalPos: Array.from(sk.restLocalPos),
    smplToTarget: Array.from(sk.smplToTarget),
    footBones: Array.from(sk.footBones),
    lockFeet: Array.from(sk.lockFeet),
  };

  fs.writeFileSync(path.join(outDir, 'skeleton.json'), JSON.stringify(skeletonJson));
  fs.writeFileSync(path.join(outDir, 'motion.json'), JSON.stringify(motion));
  fs.writeFileSync(path.join(outDir, 'golden.json'), JSON.stringify({ mapped, numFrames: N, rootPos: goldenRoot, localQuat: goldenQuat }));
  console.log(`wrote skeleton.json, motion.json, golden.json (${mapped.length} mapped bones, ${N} frames) to ${path.relative(repo, outDir)}`);
}, (err) => { console.error('GLB parse failed:', err?.message || err); process.exit(1); });
