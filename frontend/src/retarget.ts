import * as THREE from 'three';
import type { Skeleton, Params } from './core/retargetCore';

// JS-side bone-name resolution and skeleton flattening for the motion core. The
// numeric work (FK, rest-pose correction, coordinate fix, stabilization,
// grounding, foot-lock) moved to core/retargetCore.ts. This file keeps what the
// brief says stays in JS: it knows the loaded rig's bone NAMES and turns them
// into the integer indices and flat arrays the core consumes (brief section 2).

// SMPL 24-joint names, in tree order. Used only to map each SMPL joint to its
// Mixamo bone; the kinematic tree itself lives in the core.
const SMPL_NAMES = [
  'pelvis', 'left_hip', 'right_hip', 'spine1', 'left_knee', 'right_knee',
  'spine2', 'left_ankle', 'right_ankle', 'spine3', 'left_foot', 'right_foot',
  'neck', 'left_collar', 'right_collar', 'head', 'left_shoulder',
  'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist',
  'left_hand', 'right_hand',
];

// SMPL name -> Mixamo bone "core" name (prefix stripped). Watch the two naming
// offsets that cause most failures (reference, section 9): SMPL collar is the
// clavicle -> Mixamo Shoulder; SMPL shoulder is the upper arm -> Mixamo Arm;
// SMPL ankle -> Foot; SMPL foot is the toe -> ToeBase. left_hand/right_hand are
// intentionally unmapped for body-only SMPL.
const SMPL_TO_MIXAMO_CORE: Record<string, string> = {
  pelvis: 'Hips', spine1: 'Spine', spine2: 'Spine1', spine3: 'Spine2',
  neck: 'Neck', head: 'Head',
  left_collar: 'LeftShoulder', left_shoulder: 'LeftArm',
  left_elbow: 'LeftForeArm', left_wrist: 'LeftHand',
  right_collar: 'RightShoulder', right_shoulder: 'RightArm',
  right_elbow: 'RightForeArm', right_wrist: 'RightHand',
  left_hip: 'LeftUpLeg', left_knee: 'LeftLeg', left_ankle: 'LeftFoot', left_foot: 'LeftToeBase',
  right_hip: 'RightUpLeg', right_knee: 'RightLeg', right_ankle: 'RightFoot', right_foot: 'RightToeBase',
};

// "mixamorig:Hips", "mixamorig_Hips", or "Hips" all resolve to "Hips", so the
// map works regardless of how the FBX-to-GLB step renamed the bones.
function coreName(boneName: string): string {
  return boneName.replace(/^mixamorig[:_]?/i, '');
}

export interface BuiltSkeleton {
  skeleton: Skeleton; // flat arrays the core consumes
  nodes: THREE.Object3D[]; // index -> scene node, for applying the core's output
  mappedCount: number; // how many of the 22 mappable SMPL bones were found
}

// Flatten the loaded rig into the core's Skeleton. Call while the character is
// in its bind pose so the rest rotations and positions are the true rest. The
// rig is unit-scale (verified against assets/character.glb), so reading each
// node's local quaternion and position reproduces Three.js world transforms
// under the core's scale-free FK. A scaled rig would need scale baked in here.
export function buildSkeleton(root: THREE.Object3D): BuiltSkeleton {
  root.updateMatrixWorld(true);

  // Pre-order traversal: a parent is always visited before its children, so
  // parentIndex[i] < i and the core can do FK in a single forward pass.
  const nodes: THREE.Object3D[] = [];
  const indexOf = new Map<THREE.Object3D, number>();
  root.traverse((o) => { indexOf.set(o, nodes.length); nodes.push(o); });

  const n = nodes.length;
  const parentIndex = new Int32Array(n);
  const restLocalQuat = new Float32Array(n * 4);
  const restLocalPos = new Float32Array(n * 3);
  const byCore = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const o = nodes[i];
    parentIndex[i] = o.parent && indexOf.has(o.parent) ? indexOf.get(o.parent)! : -1;
    const q = o.quaternion, p = o.position;
    restLocalQuat[i * 4] = q.x; restLocalQuat[i * 4 + 1] = q.y;
    restLocalQuat[i * 4 + 2] = q.z; restLocalQuat[i * 4 + 3] = q.w;
    restLocalPos[i * 3] = p.x; restLocalPos[i * 3 + 1] = p.y; restLocalPos[i * 3 + 2] = p.z;
    if ((o as THREE.Bone).isBone) byCore.set(coreName(o.name), i);
  }

  const smplToTarget = new Int32Array(24).fill(-1);
  let mappedCount = 0;
  for (let j = 0; j < 24; j++) {
    const core = SMPL_TO_MIXAMO_CORE[SMPL_NAMES[j]];
    if (!core) continue;
    const idx = byCore.get(core);
    if (idx === undefined) continue;
    smplToTarget[j] = idx;
    mappedCount++;
  }

  const idxOrNeg = (c: string) => (byCore.has(c) ? byCore.get(c)! : -1);
  const footBones = Int32Array.from(
    ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'].map(idxOrNeg).filter((i) => i >= 0),
  );
  const lockFeet = Int32Array.from([idxOrNeg('LeftFoot'), idxOrNeg('RightFoot')]);

  return {
    skeleton: { numBones: n, parentIndex, restLocalQuat, restLocalPos, smplToTarget, footBones, lockFeet },
    nodes,
    mappedCount,
  };
}

// The empirically-tuned constants, handed to the core as params so they stay
// tunable from JS rather than baked into the math (brief section 3). Found by
// hand against real EDGE clips; do not re-derive:
//  - coordFix: +90 deg about Z brings the body upright in Y-up (not the
//    reference's -90 about X; real EDGE motion is not plain Z-up).
//  - rootUpright (ROOT_UPRIGHT): 1 holds the pelvis vertical, removing EDGE's
//    ~30 deg pitch + ~25 deg recline; 0 is faithful to EDGE.
//  - footLock (FOOT_LOCK): 1 locks the planted foot so it does not slide.
//  - recenterWin (RECENTER_WIN): high-pass window so the dancer does not drift.
export function defaultParams(): Params {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2, 'XYZ'));
  return {
    rootUpright: 1.0,
    footLock: 1.0,
    recenterWin: 61,
    coordFix: new Float32Array([q.x, q.y, q.z, q.w]),
  };
}
