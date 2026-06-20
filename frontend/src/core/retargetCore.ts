// Pure motion core: SMPL to Mixamo retarget plus the cleanup passes, as plain
// math over flat typed arrays with no Three.js dependency. This is the oracle
// the C++/WASM port is checked against and the runtime fallback if WASM fails
// to load, so it must reproduce the previous Three.js path within float
// tolerance. The exported interface (setup / computeAll / computeFrame /
// setParams / free) mirrors the WASM module surface so the two are swappable.
//
// What it does, per the brief:
//  - Forward-kinematic the SMPL local axis-angle to global rotations.
//  - Rest-pose correction onto the loaded target skeleton.
//  - Coordinate fix into Y-up.
//  - Pelvis stabilization (keep yaw, zero pitch/roll on the Hips local).
//  - Grounding (clamp lowest foot to the floor) and the foot-lock high-pass.
//
// The quaternion and euler formulas below match Three.js exactly (multiply,
// applyQuaternion, setFromAxisAngle, and the YXZ euler decompose/recompose),
// because the empirical look depends on those exact operations.

// SMPL 24-joint kinematic tree. Parent index, -1 for the root. Parent before
// child so the FK loop can read a parent global before its child.
const SMPL_PARENTS = [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19, 20, 21];

// ---- Inputs (resolved by JS, handed to the core as indices + flat arrays) ----

export interface Skeleton {
  numBones: number;
  // Pre-order (parent index < child index), so a single forward pass does FK.
  parentIndex: Int32Array; // [numBones], -1 for the root node
  restLocalQuat: Float32Array; // [numBones*4] xyzw, bone local rest rotation
  restLocalPos: Float32Array; // [numBones*3], bone local rest position
  smplToTarget: Int32Array; // [24], target bone index per SMPL joint, -1 if unmapped
  footBones: Int32Array; // target indices used for grounding (feet + toes present)
  lockFeet: Int32Array; // [2] target indices [LeftFoot, RightFoot], -1 if absent
}

export interface MotionInput {
  fps: number;
  numFrames: number;
  smplPoses: Float32Array; // [numFrames*72] local axis-angle
  rootTranslation: Float32Array; // [numFrames*3], pelvis meters (carried, unused for now)
  footContact: Float32Array; // [numFrames*4], 0/1 (zero-filled today, unused)
}

export interface Params {
  rootUpright: number; // ROOT_UPRIGHT: 0 faithful to EDGE, 1 pelvis always vertical
  footLock: number; // FOOT_LOCK: 0 centered, 1 plant the support foot
  recenterWin: number; // RECENTER_WIN: high-pass window (frames) for the lock path
  coordFix: Float32Array; // [4] xyzw, the coordinate-fix quaternion
}

export interface CoreOutput {
  localQuat: Float32Array; // [numFrames*numBones*4], target bone local rotations
  rootPos: Float32Array; // [numFrames*3], grounded + foot-locked root position
}

export interface MotionCore {
  setup(skeleton: Skeleton, motion: MotionInput, params: Params): void;
  setParams(params: Params): void;
  computeAll(): CoreOutput;
  computeFrame(frame: number, outLocalQuat: Float32Array, outRootPos: Float32Array): void;
  free(): void;
}

// ---- Quaternion / vector math, matching Three.js ----

type Quat = [number, number, number, number]; // x, y, z, w

function quatFromAxisAngle(x: number, y: number, z: number): Quat {
  // Matches reference axisAngleToQuat + THREE.setFromAxisAngle: normalize the
  // axis by its length (the rotation angle), identity below a small epsilon.
  const a = Math.hypot(x, y, z);
  if (a < 1e-8) return [0, 0, 0, 1];
  const half = a / 2;
  const s = Math.sin(half) / a; // divide by a folds in the axis normalization
  return [x * s, y * s, z * s, Math.cos(half)];
}

// a * b (THREE.Quaternion.multiplyQuaternions / a.multiply(b)).
function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    ax * bw + aw * bx + ay * bz - az * by,
    ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

// Inverse of a unit quaternion is its conjugate (THREE.invert for unit quats).
function quatConj(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

// Rotate a vector by a quaternion (THREE.Vector3.applyQuaternion), in place.
function applyQuat(q: Quat, vx: number, vy: number, vz: number): [number, number, number] {
  const [qx, qy, qz, qw] = q;
  const ix = qw * vx + qy * vz - qz * vy;
  const iy = qw * vy + qz * vx - qx * vz;
  const iz = qw * vz + qx * vy - qy * vx;
  const iw = -qx * vx - qy * vy - qz * vz;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}

// YXZ euler from a quaternion, via the rotation matrix (THREE.Euler.setFrom-
// Quaternion with order 'YXZ', which builds the matrix then reads it). Only the
// matrix elements the YXZ case needs are computed.
function eulerYXZFromQuat(q: Quat): [number, number, number] {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const m11 = 1 - (yy + zz);
  const m13 = xz + wy;
  const m21 = xy + wz;
  const m22 = 1 - (xx + zz);
  const m23 = yz - wx;
  const m31 = xz - wy;
  const m33 = 1 - (xx + yy);
  const ex = Math.asin(-Math.max(-1, Math.min(1, m23)));
  let ey: number, ez: number;
  if (Math.abs(m23) < 0.9999999) {
    ey = Math.atan2(m13, m33);
    ez = Math.atan2(m21, m22);
  } else {
    ey = Math.atan2(-m31, m11);
    ez = 0;
  }
  return [ex, ey, ez];
}

// Quaternion from a YXZ euler (THREE.Quaternion.setFromEuler, order 'YXZ').
function quatFromEulerYXZ(ex: number, ey: number, ez: number): Quat {
  const c1 = Math.cos(ex / 2), c2 = Math.cos(ey / 2), c3 = Math.cos(ez / 2);
  const s1 = Math.sin(ex / 2), s2 = Math.sin(ey / 2), s3 = Math.sin(ez / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 - s1 * s2 * c3,
    c1 * c2 * c3 + s1 * s2 * s3,
  ];
}

function readQuat(buf: Float32Array, i: number): Quat {
  const o = i * 4;
  return [buf[o], buf[o + 1], buf[o + 2], buf[o + 3]];
}

function writeQuat(buf: Float32Array, i: number, q: Quat): void {
  const o = i * 4;
  buf[o] = q[0]; buf[o + 1] = q[1]; buf[o + 2] = q[2]; buf[o + 3] = q[3];
}

// ---- The core ----

class TsMotionCore implements MotionCore {
  private skel!: Skeleton;
  private motion!: MotionInput;
  private params!: Params;

  // Per-bone source SMPL joint index, -1 if the bone is unmapped. Lets us test
  // "is this bone's parent a mapped bone" in O(1) during localization.
  private mappedSmpl!: Int32Array;
  // Mapped target bones in target-hierarchy depth order (parent before child),
  // and the SMPL joint each one is driven by.
  private order!: number[];
  private orderSmpl!: number[];

  private coordFixInv!: Quat;
  private bindWorldRot!: Float32Array; // [numBones*4] rest world rotations (tgtRest)
  private groundY = 0; // load-time lowest foot world Y, the floor to clamp to
  private rootPath!: Float32Array; // [numFrames*2] foot-lock x,z offsets, high-passed

  // Reused scratch so per-frame work does not allocate.
  private desiredWorld!: Float32Array; // [numBones*4]
  private worldRot!: Float32Array; // [numBones*4]
  private worldPos!: Float32Array; // [numBones*3]

  setup(skeleton: Skeleton, motion: MotionInput, params: Params): void {
    this.skel = skeleton;
    this.motion = motion;
    this.params = params;
    const n = skeleton.numBones;
    this.desiredWorld = new Float32Array(n * 4);
    this.worldRot = new Float32Array(n * 4);
    this.worldPos = new Float32Array(n * 3);
    this.bindWorldRot = new Float32Array(n * 4);

    // Which bones are mapped, and the processing order (by target depth).
    this.mappedSmpl = new Int32Array(n).fill(-1);
    const entries: { bone: number; smpl: number; depth: number }[] = [];
    for (let j = 0; j < 24; j++) {
      const b = skeleton.smplToTarget[j];
      if (b < 0) continue;
      this.mappedSmpl[b] = j;
      entries.push({ bone: b, smpl: j, depth: this.depth(b) });
    }
    entries.sort((a, b) => a.depth - b.depth); // parent before child
    this.order = entries.map((e) => e.bone);
    this.orderSmpl = entries.map((e) => e.smpl);

    this.recompute();
  }

  setParams(params: Params): void {
    this.params = params;
    this.recompute();
  }

  free(): void {
    // Nothing to release for the TS path; present so the interface matches WASM.
  }

  // Recompute everything that depends on params: the coord-fix inverse, the rest
  // world rotations (tgtRest), the floor height, and the foot-lock path.
  private recompute(): void {
    const cf = this.params.coordFix;
    this.coordFixInv = quatConj([cf[0], cf[1], cf[2], cf[3]]);
    this.computeBind();
    this.computeRootPath();
  }

  private depth(b: number): number {
    let d = 0;
    let p = this.skel.parentIndex[b];
    while (p >= 0) { d++; p = this.skel.parentIndex[p]; }
    return d;
  }

  // Rest-pose FK over the whole skeleton: world rotations (tgtRest) and world
  // positions, using the root's true rest position so groundY carries the rig's
  // load-time world offset (the per-frame pass zeroes the root instead).
  private computeBind(): void {
    const { numBones, parentIndex, restLocalQuat, restLocalPos, footBones } = this.skel;
    for (let i = 0; i < numBones; i++) {
      const p = parentIndex[i];
      const local = readQuat(restLocalQuat, i);
      const lx = restLocalPos[i * 3], ly = restLocalPos[i * 3 + 1], lz = restLocalPos[i * 3 + 2];
      if (p < 0) {
        writeQuat(this.bindWorldRot, i, local);
        this.worldPos[i * 3] = lx; this.worldPos[i * 3 + 1] = ly; this.worldPos[i * 3 + 2] = lz;
      } else {
        const pr = readQuat(this.bindWorldRot, p);
        writeQuat(this.bindWorldRot, i, quatMul(pr, local));
        const [rx, ry, rz] = applyQuat(pr, lx, ly, lz);
        this.worldPos[i * 3] = this.worldPos[p * 3] + rx;
        this.worldPos[i * 3 + 1] = this.worldPos[p * 3 + 1] + ry;
        this.worldPos[i * 3 + 2] = this.worldPos[p * 3 + 2] + rz;
      }
    }
    let minY = Infinity;
    for (const b of footBones) minY = Math.min(minY, this.worldPos[b * 3 + 1]);
    this.groundY = minY === Infinity ? 0 : minY;
  }

  // SMPL local axis-angle (length 72) -> per-joint world rotations, with the
  // coordinate fix premultiplied (smplAnimGlobals).
  private smplAnimGlobals(frame: number): Quat[] {
    const poses = this.motion.smplPoses;
    const base = frame * 72;
    const local: Quat[] = new Array(24);
    for (let j = 0; j < 24; j++) {
      local[j] = quatFromAxisAngle(poses[base + j * 3], poses[base + j * 3 + 1], poses[base + j * 3 + 2]);
    }
    // FK over the raw globals first, then premultiply the coordinate fix in a
    // separate pass. Folding the fix into the loop would reuse an already-fixed
    // parent and compound the fix down the tree.
    const raw: Quat[] = new Array(24);
    for (let j = 0; j < 24; j++) {
      const p = SMPL_PARENTS[j];
      raw[j] = p === -1 ? local[j] : quatMul(raw[p], local[j]);
    }
    const cf: Quat = [this.params.coordFix[0], this.params.coordFix[1], this.params.coordFix[2], this.params.coordFix[3]];
    const global: Quat[] = new Array(24);
    for (let j = 0; j < 24; j++) global[j] = quatMul(cf, raw[j]);
    return global;
  }

  // Fill outLocal (length numBones*4) with the retargeted local rotations for a
  // frame. Unmapped bones keep their rest local rotation. Matches applyFrame.
  private retargetFrame(frame: number, outLocal: Float32Array): void {
    const { restLocalQuat, parentIndex } = this.skel;
    outLocal.set(restLocalQuat); // unmapped bones hold rest
    const anim = this.smplAnimGlobals(frame);
    const up = this.params.rootUpright;
    for (let k = 0; k < this.order.length; k++) {
      const bone = this.order[k];
      const smpl = this.orderSmpl[k];
      // desired world = srcAnim * srcRestInv * tgtRest. SMPL rests at identity,
      // so srcRestInv is just the coordinate-fix inverse for every bone.
      const desired = quatMul(quatMul(anim[smpl], this.coordFixInv), readQuat(this.bindWorldRot, bone));
      writeQuat(this.desiredWorld, bone, desired); // children localize against this
      // The pelvis is localized upright (keep yaw, zero pitch/roll); the lean
      // stays in the hips local rotation so the body below de-leans with it.
      const apply = smpl === 0 && up > 0 ? this.stabilize(desired) : desired;
      const p = parentIndex[bone];
      let parentWorld: Quat;
      if (p >= 0 && this.mappedSmpl[p] >= 0) parentWorld = readQuat(this.desiredWorld, p);
      else if (p >= 0) parentWorld = readQuat(this.bindWorldRot, p);
      else parentWorld = [0, 0, 0, 1];
      writeQuat(outLocal, bone, quatMul(quatConj(parentWorld), apply));
    }
  }

  private stabilize(q: Quat): Quat {
    const [ex, ey, ez] = eulerYXZFromQuat(q);
    const k = 1 - this.params.rootUpright;
    return quatFromEulerYXZ(ex * k, ey, ez * k);
  }

  // World-position FK with the root translation at the origin, using the given
  // per-frame local rotations. Writes worldRot/worldPos scratch.
  private fkPositions(outLocal: Float32Array): void {
    const { numBones, parentIndex, restLocalPos } = this.skel;
    for (let i = 0; i < numBones; i++) {
      const p = parentIndex[i];
      const local = readQuat(outLocal, i);
      const lx = restLocalPos[i * 3], ly = restLocalPos[i * 3 + 1], lz = restLocalPos[i * 3 + 2];
      if (p < 0) {
        writeQuat(this.worldRot, i, local);
        this.worldPos[i * 3] = 0; this.worldPos[i * 3 + 1] = 0; this.worldPos[i * 3 + 2] = 0;
      } else {
        const pr = readQuat(this.worldRot, p);
        writeQuat(this.worldRot, i, quatMul(pr, local));
        const [rx, ry, rz] = applyQuat(pr, lx, ly, lz);
        this.worldPos[i * 3] = this.worldPos[p * 3] + rx;
        this.worldPos[i * 3 + 1] = this.worldPos[p * 3 + 1] + ry;
        this.worldPos[i * 3 + 2] = this.worldPos[p * 3 + 2] + rz;
      }
    }
  }

  private minFootY(): number {
    let minY = Infinity;
    for (const b of this.skel.footBones) minY = Math.min(minY, this.worldPos[b * 3 + 1]);
    return minY === Infinity ? 0 : minY;
  }

  // Foot-lock path: keep the planted (lower) foot horizontally fixed by
  // offsetting the root, then high-pass so the dancer does not drift off.
  // Reproduces Viewer.computeRootPath (smooth window 7, then subtract a slow
  // RECENTER_WIN moving average).
  private computeRootPath(): void {
    const N = this.motion.numFrames;
    this.rootPath = new Float32Array(N * 2);
    const [lf, rf] = [this.skel.lockFeet[0], this.skel.lockFeet[1]];
    if (lf < 0 || rf < 0) return; // no feet to lock; leave offsets at zero

    const raw = new Float32Array(N * 2);
    const scratch = new Float32Array(this.skel.numBones * 4);
    let anchorX = 0, anchorZ = 0, offX = 0, offZ = 0, prev = '';
    for (let f = 0; f < N; f++) {
      this.retargetFrame(f, scratch);
      this.fkPositions(scratch);
      const lx = this.worldPos[lf * 3], ly = this.worldPos[lf * 3 + 1], lz = this.worldPos[lf * 3 + 2];
      const rx = this.worldPos[rf * 3], ry = this.worldPos[rf * 3 + 1], rz = this.worldPos[rf * 3 + 2];
      const supL = ly <= ry;
      const fx = supL ? lx : rx, fz = supL ? lz : rz, cur = supL ? 'L' : 'R';
      if (cur !== prev) { anchorX = fx + offX; anchorZ = fz + offZ; prev = cur; }
      offX = anchorX - fx;
      offZ = anchorZ - fz;
      raw[f * 2] = offX; raw[f * 2 + 1] = offZ;
    }
    const smoothed = movingAvg2(raw, N, 7);
    const drift = movingAvg2(smoothed, N, this.params.recenterWin);
    for (let i = 0; i < N; i++) {
      this.rootPath[i * 2] = smoothed[i * 2] - drift[i * 2];
      this.rootPath[i * 2 + 1] = smoothed[i * 2 + 1] - drift[i * 2 + 1];
    }
  }

  computeFrame(frame: number, outLocalQuat: Float32Array, outRootPos: Float32Array): void {
    const N = this.motion.numFrames;
    const f = ((Math.floor(frame) % N) + N) % N;
    this.retargetFrame(f, outLocalQuat);
    this.fkPositions(outLocalQuat);
    const lock = this.params.footLock;
    const noFeet = this.skel.footBones.length === 0;
    outRootPos[0] = this.rootPath[f * 2] * lock;
    outRootPos[1] = noFeet ? 0 : this.groundY - this.minFootY();
    outRootPos[2] = this.rootPath[f * 2 + 1] * lock;
  }

  computeAll(): CoreOutput {
    const N = this.motion.numFrames;
    const n = this.skel.numBones;
    const localQuat = new Float32Array(N * n * 4);
    const rootPos = new Float32Array(N * 3);
    const frameLocal = new Float32Array(n * 4);
    const frameRoot = new Float32Array(3);
    for (let f = 0; f < N; f++) {
      this.computeFrame(f, frameLocal, frameRoot);
      localQuat.set(frameLocal, f * n * 4);
      rootPos[f * 3] = frameRoot[0];
      rootPos[f * 3 + 1] = frameRoot[1];
      rootPos[f * 3 + 2] = frameRoot[2];
    }
    return { localQuat, rootPos };
  }
}

// Centered moving average over an [N*2] (x,z) signal, matching Viewer.movingAvg.
function movingAvg2(p: Float32Array, n: number, win: number): Float32Array {
  const half = (win - 1) / 2;
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    let sx = 0, sz = 0, c = 0;
    const lo = Math.max(0, i - half), hi = Math.min(n - 1, i + half);
    for (let j = lo; j <= hi; j++) { sx += p[j * 2]; sz += p[j * 2 + 1]; c++; }
    out[i * 2] = sx / c; out[i * 2 + 1] = sz / c;
  }
  return out;
}

export function createTsCore(): MotionCore {
  return new TsMotionCore();
}
