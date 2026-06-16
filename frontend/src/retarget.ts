import * as THREE from 'three';

// SMPL to Mixamo retarget, browser path. Implements the rest-pose correction
// from reference/smpl_to_mixamo_retarget.js (brief section 9). The caller
// supplies per-frame SMPL LOCAL axis-angle (the fixture); we forward-kinematic
// it to globals, then transfer to the loaded Mixamo skeleton.

// SMPL 24-joint tree: names and parent index (-1 = root). Parent-before-child.
const SMPL_NAMES = [
  'pelvis', 'left_hip', 'right_hip', 'spine1', 'left_knee', 'right_knee',
  'spine2', 'left_ankle', 'right_ankle', 'spine3', 'left_foot', 'right_foot',
  'neck', 'left_collar', 'right_collar', 'head', 'left_shoulder',
  'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist',
  'left_hand', 'right_hand',
];
const SMPL_PARENTS = [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19, 20, 21];

// SMPL name -> Mixamo bone "core" name (prefix stripped). Watch the two naming
// offsets that cause most failures (reference, section 9): SMPL collar is the
// clavicle -> Mixamo Shoulder; SMPL shoulder is the upper arm -> Mixamo Arm;
// SMPL ankle -> Foot; SMPL foot is the toe -> ToeBase. left_hand/right_hand
// are intentionally unmapped for body-only SMPL.
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

// Coordinate fix into Mixamo's Y-up frame (reference, section 9). Empirically,
// real EDGE motion stands upright with +90 deg about Z (not the -90 about X the
// reference assumed); found by live-tuning the orientation against real clips.
const _coordFix = new THREE.Quaternion()
  .setFromEuler(new THREE.Euler(0, 0, Math.PI / 2, 'XYZ'));

// Pelvis upright strength. EDGE's root carries a large off-vertical rotation
// (analysis: ~30 deg of pitch plus a ~25 deg constant recline) that reads as
// the dancer leaning forward and back. Removing the pelvis pitch/roll while
// keeping yaw de-leans the whole body. 0 = faithful to EDGE, 1 = pelvis always
// vertical. Tune to taste.
const ROOT_UPRIGHT = 1.0;

// "mixamorig:Hips", "mixamorig_Hips", or "Hips" all resolve to "Hips", so the
// map works regardless of how the FBX-to-GLB step renamed the bones.
function coreName(boneName: string): string {
  return boneName.replace(/^mixamorig[:_]?/i, '');
}

export function resolveTargetBones(root: THREE.Object3D): Map<string, THREE.Bone> {
  const byCore = new Map<string, THREE.Bone>();
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) byCore.set(coreName(o.name), o as THREE.Bone);
  });
  return byCore;
}

const _axis = new THREE.Vector3();

function axisAngleToQuat(x: number, y: number, z: number, out: THREE.Quaternion): THREE.Quaternion {
  const a = Math.hypot(x, y, z);
  if (a < 1e-8) out.set(0, 0, 0, 1);
  else out.setFromAxisAngle(_axis.set(x / a, y / a, z / a), a);
  return out;
}

// One frame of SMPL LOCAL axis-angle (length 72) -> per-joint GLOBAL rotations,
// with COORD_FIX premultiplied so the motion is conjugated into the target
// frame (reference, section 4).
export function smplAnimGlobals(pose: number[]): THREE.Quaternion[] {
  const local: THREE.Quaternion[] = [];
  for (let j = 0; j < 24; j++) {
    local[j] = axisAngleToQuat(pose[j * 3], pose[j * 3 + 1], pose[j * 3 + 2], new THREE.Quaternion());
  }
  const global: THREE.Quaternion[] = [];
  for (let j = 0; j < 24; j++) {
    const p = SMPL_PARENTS[j];
    global[j] = p === -1 ? local[j].clone() : global[p].clone().multiply(local[j]);
  }
  for (let j = 0; j < 24; j++) global[j].premultiply(_coordFix);
  return global;
}

const _e = new THREE.Euler();

// Return an upright version of a world orientation: keep yaw (turning), scale
// pitch (front/back lean) and roll (side tilt) toward zero by ROOT_UPRIGHT.
function stabilizeUpright(q: THREE.Quaternion): THREE.Quaternion {
  _e.setFromQuaternion(q, 'YXZ');
  _e.x *= 1 - ROOT_UPRIGHT;
  _e.z *= 1 - ROOT_UPRIGHT;
  return new THREE.Quaternion().setFromEuler(_e);
}

export interface RetargetRow {
  smplIndex: number;
  bone: THREE.Bone;
  srcRestInv: THREE.Quaternion; // inverse of the coord-fixed SMPL rest global
  tgtRest: THREE.Quaternion; // target bone world rotation in bind pose
}

function boneDepth(b: THREE.Object3D): number {
  let d = 0;
  let n: THREE.Object3D | null = b;
  while (n.parent) { d++; n = n.parent; }
  return d;
}

// Precompute per-bone constants. Call while the character is in its bind pose,
// so tgtRest reads the true rest world rotation. SMPL rest globals are identity
// (all local rotations zero), so the coord-fixed source rest is just COORD_FIX.
export function buildRetargetTable(targetByCore: Map<string, THREE.Bone>): RetargetRow[] {
  const srcRestInv = _coordFix.clone().invert();
  const rows: RetargetRow[] = [];
  for (let j = 0; j < 24; j++) {
    const core = SMPL_TO_MIXAMO_CORE[SMPL_NAMES[j]];
    if (!core) continue;
    const bone = targetByCore.get(core);
    if (!bone) continue;
    const tgtRest = new THREE.Quaternion();
    bone.getWorldQuaternion(tgtRest);
    rows.push({ smplIndex: j, bone, srcRestInv: srcRestInv.clone(), tgtRest });
  }
  // Parent-before-child so a parent's desired world is ready when we localize
  // its child.
  rows.sort((a, b) => boneDepth(a.bone) - boneDepth(b.bone));
  return rows;
}

// Apply one frame in place. desired world = srcAnim * srcRestInv * tgtRest;
// local = parentDesiredWorld^-1 * desired (reference applyFrame).
export function applyFrame(rows: RetargetRow[], animGlobals: THREE.Quaternion[]): void {
  const desired = new Map<THREE.Bone, THREE.Quaternion>();
  for (const row of rows) {
    const d = animGlobals[row.smplIndex].clone()
      .multiply(row.srcRestInv)
      .multiply(row.tgtRest);
    // Store the original world orientation so children localize against the
    // real pose. For the pelvis (root) we localize an upright version instead,
    // which de-leans the whole body while keeping each joint's pose relative
    // to the hips (the lean lives in the hips' local rotation).
    desired.set(row.bone, d);
    const apply = row.smplIndex === 0 && ROOT_UPRIGHT > 0 ? stabilizeUpright(d) : d;

    const parent = row.bone.parent;
    const parentWorld = new THREE.Quaternion();
    if (parent && desired.has(parent as THREE.Bone)) {
      parentWorld.copy(desired.get(parent as THREE.Bone)!);
    } else if (parent) {
      parent.getWorldQuaternion(parentWorld);
    }
    row.bone.quaternion.copy(parentWorld.invert().multiply(apply));
  }
}
