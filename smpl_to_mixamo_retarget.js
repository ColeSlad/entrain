// smpl_to_mixamo_retarget.js
//
// Reference scaffolding for retargeting SMPL dance motion (EDGE / Lodge /
// Bailando output) onto a standard Mixamo-rigged glTF character in Three.js.
//
// This file pins down the two fiddly parts: the bone correspondence map and
// the rest-pose alignment correction. It is not a finished production
// retargeter. You supply: (a) per-frame SMPL joint GLOBAL rotations (forward-
// kinematics the model's LOCAL axis-angle/6D output down the SMPL tree first),
// (b) the SMPL rest-pose global rotations, and (c) a loaded Three.js target
// skeleton (THREE.Bone objects from GLTFLoader) in its own bind/rest pose.
//
// Tested mental model, not a drop-in. Expect to debug rest alignment + axis.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// 1. SMPL 24-joint skeleton: index, name, parent index (-1 = root).
//    This ordering is the canonical SMPL body kinematic tree.
// ---------------------------------------------------------------------------
export const SMPL_JOINTS = [
  { index: 0,  name: 'pelvis',         parent: -1 },
  { index: 1,  name: 'left_hip',       parent: 0  },
  { index: 2,  name: 'right_hip',      parent: 0  },
  { index: 3,  name: 'spine1',         parent: 0  },
  { index: 4,  name: 'left_knee',      parent: 1  },
  { index: 5,  name: 'right_knee',     parent: 2  },
  { index: 6,  name: 'spine2',         parent: 3  },
  { index: 7,  name: 'left_ankle',     parent: 4  },
  { index: 8,  name: 'right_ankle',    parent: 5  },
  { index: 9,  name: 'spine3',         parent: 6  },
  { index: 10, name: 'left_foot',      parent: 7  },
  { index: 11, name: 'right_foot',     parent: 8  },
  { index: 12, name: 'neck',           parent: 9  },
  { index: 13, name: 'left_collar',    parent: 9  },
  { index: 14, name: 'right_collar',   parent: 9  },
  { index: 15, name: 'head',           parent: 12 },
  { index: 16, name: 'left_shoulder',  parent: 13 },
  { index: 17, name: 'right_shoulder', parent: 14 },
  { index: 18, name: 'left_elbow',     parent: 16 },
  { index: 19, name: 'right_elbow',    parent: 17 },
  { index: 20, name: 'left_wrist',     parent: 18 },
  { index: 21, name: 'right_wrist',    parent: 19 },
  { index: 22, name: 'left_hand',      parent: 20 },
  { index: 23, name: 'right_hand',     parent: 21 },
];

// ---------------------------------------------------------------------------
// 2. SMPL name -> Mixamo bone name.
//
//    WATCH THE TWO NAMING OFFSETS. They are the most common silent mistake:
//
//    - SMPL "collar"    = clavicle  -> Mixamo "Shoulder"
//      SMPL "shoulder"  = upper arm -> Mixamo "Arm"
//      (If you map SMPL shoulder -> Mixamo Shoulder, the arms break.)
//
//    - SMPL "ankle"     = ankle     -> Mixamo "Foot"
//      SMPL "foot"      = toe/ball  -> Mixamo "ToeBase"
//
//    SMPL spine1/2/3 -> Mixamo Spine/Spine1/Spine2 (heights differ slightly).
//    SMPL left_hand/right_hand have no meaningful body-only target; dropped.
//    Mixamo fingers, HeadTop_End, Toe_End, and any twist bones get no source
//    and simply hold their rest rotation.
// ---------------------------------------------------------------------------
export const SMPL_TO_MIXAMO = {
  pelvis:         'mixamorig:Hips',
  spine1:         'mixamorig:Spine',
  spine2:         'mixamorig:Spine1',
  spine3:         'mixamorig:Spine2',
  neck:           'mixamorig:Neck',
  head:           'mixamorig:Head',

  left_collar:    'mixamorig:LeftShoulder',   // clavicle
  left_shoulder:  'mixamorig:LeftArm',        // upper arm
  left_elbow:     'mixamorig:LeftForeArm',
  left_wrist:     'mixamorig:LeftHand',

  right_collar:   'mixamorig:RightShoulder',
  right_shoulder: 'mixamorig:RightArm',
  right_elbow:    'mixamorig:RightForeArm',
  right_wrist:    'mixamorig:RightHand',

  left_hip:       'mixamorig:LeftUpLeg',
  left_knee:      'mixamorig:LeftLeg',
  left_ankle:     'mixamorig:LeftFoot',
  left_foot:      'mixamorig:LeftToeBase',

  right_hip:      'mixamorig:RightUpLeg',
  right_knee:     'mixamorig:RightLeg',
  right_ankle:    'mixamorig:RightFoot',
  right_foot:     'mixamorig:RightToeBase',

  // left_hand / right_hand: intentionally unmapped for body-only SMPL.
};

// Inverse map (Mixamo -> SMPL), the form SkeletonUtils.retargetClip wants for
// its `names` option (it looks up names[targetBoneName] = sourceBoneName).
export const MIXAMO_TO_SMPL = Object.fromEntries(
  Object.entries(SMPL_TO_MIXAMO).map(([smpl, mixamo]) => [mixamo, smpl])
);

// ---------------------------------------------------------------------------
// 3. Coordinate conversion.
//
//    SMPL/AMASS pose data is often NOT in Three.js's Y-up frame. If your
//    character ends up lying on its back, this is why. Verify empirically;
//    Z-up -> Y-up is a -90 deg rotation about X. Set to identity if your
//    source is already Y-up.
// ---------------------------------------------------------------------------
export const COORD_FIX = new THREE.Quaternion()
  .setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

// ---------------------------------------------------------------------------
// 4. Rest-pose alignment, the core correction.
//
//    Joint rotations are stored relative to each skeleton's OWN rest pose, and
//    SMPL's rest is an arms-down A-pose while Mixamo's is a T-pose. So you
//    cannot copy local rotations. The transfer, all in WORLD space:
//
//      M(j)             = R_srcAnim(j) * R_srcRest(j)^-1     // motion vs rest
//      R_tgtGlobal(b)   = M(j) * R_tgtRest(b)                // same motion on target
//                       = R_srcAnim(j) * R_srcRest(j)^-1 * R_tgtRest(b)
//      R_tgtLocal(b)    = R_tgtGlobal(parent(b))^-1 * R_tgtGlobal(b)
//
//    Premultiplying COORD_FIX into BOTH srcAnim and srcRest globals (done by
//    the caller, see buildSourceRest below) makes the motion come out
//    correctly conjugated into the target frame for free.
//
//    THREE API note: q.multiply(p) means q*p. Newer Three uses .invert();
//    older versions use .inverse() (rename if needed).
// ---------------------------------------------------------------------------

// Precompute per-target-bone the constant we reuse every frame: srcRest^-1.
// targetBones: Map<mixamoName, THREE.Bone> from the loaded glTF skeleton, in
// rest pose. srcRestGlobal: Map<smplName, THREE.Quaternion> with COORD_FIX
// already applied. Returns helper data keyed by mixamo bone name.
export function buildRetargetTable(targetBones, srcRestGlobalFixed) {
  const table = [];
  for (const [smplName, mixamoName] of Object.entries(SMPL_TO_MIXAMO)) {
    const bone = targetBones.get(mixamoName);
    if (!bone) continue; // bone absent on this rig; skip
    const srcRest = srcRestGlobalFixed.get(smplName);
    if (!srcRest) continue;

    // target bone rest global rotation
    const tgtRest = new THREE.Quaternion();
    bone.getWorldQuaternion(tgtRest); // call while character is in rest pose

    table.push({
      smplName,
      mixamoName,
      bone,
      srcRestInv: srcRest.clone().invert(),
      tgtRest,
    });
  }
  // Sort parent-before-child so parent world rotation is ready when we
  // convert a child to local. Uses the live Three.js bone hierarchy depth.
  table.sort((a, b) => depth(a.bone) - depth(b.bone));
  return table;
}

function depth(bone) {
  let d = 0, n = bone;
  while (n.parent && n.parent.isBone) { d++; n = n.parent; }
  return d;
}

// Apply one frame. srcAnimGlobalFixed: Map<smplName, THREE.Quaternion> of this
// frame's SMPL joint world rotations with COORD_FIX premultiplied. Writes
// local quaternions onto the target bones in place.
export function applyFrame(table, srcAnimGlobalFixed) {
  const desiredGlobal = new Map(); // mixamoName -> world quat we want

  for (const row of table) {
    const srcAnim = srcAnimGlobalFixed.get(row.smplName);
    if (!srcAnim) continue;

    // desired world rotation = srcAnim * srcRestInv * tgtRest
    const desired = srcAnim.clone()
      .multiply(row.srcRestInv)
      .multiply(row.tgtRest);
    desiredGlobal.set(row.mixamoName, desired);

    // convert to local using the desired world rotation of the parent bone if
    // the parent is itself retargeted, else use the parent's current world.
    const parent = row.bone.parent;
    const parentWorld = new THREE.Quaternion();
    if (parent && desiredGlobal.has(parent.name)) {
      parentWorld.copy(desiredGlobal.get(parent.name));
    } else if (parent && parent.isBone) {
      parent.getWorldQuaternion(parentWorld);
    }
    row.bone.quaternion.copy(parentWorld.invert().multiply(desired));
  }
}

// ---------------------------------------------------------------------------
// 5. Root translation. Scale SMPL pelvis translation by the height ratio so
//    the character does not drift or moonwalk, and rotate it by COORD_FIX.
//    Set lockInPlace=true to keep horizontal position fixed (dancer stays
//    centered) and only use vertical bob.
// ---------------------------------------------------------------------------
export function mapRootTranslation(smplTranslation, scale, lockInPlace = false) {
  const t = smplTranslation.clone().applyQuaternion(COORD_FIX).multiplyScalar(scale);
  if (lockInPlace) { t.x = 0; t.z = 0; }
  return t; // assign to mixamorig:Hips position track / bone.position
}

// scale = (target hip height in meters) / (SMPL hip height in meters).
// Measure both in rest pose; tune by eye if feet float or sink.

// ---------------------------------------------------------------------------
// 6. Shortcut path: let Three.js SkeletonUtils do the math.
//    Requires building a SOURCE SkinnedMesh whose skeleton is the SMPL rig in
//    SMPL rest pose, with the dance motion as an AnimationClip on it. Then:
//
//      import { retargetClip } from 'three/examples/jsm/utils/SkeletonUtils.js';
//      const clip = retargetClip(targetSkinnedMesh, sourceSkinnedMesh,
//                                sourceClip, {
//        fps: 30,                 // or 60 for AIST++
//        names: MIXAMO_TO_SMPL,   // target bone name -> source bone name
//        hip: 'pelvis',
//        scale: scale,            // height ratio above
//      });
//      mixer.clipAction(clip).play();
//
//    SkeletonUtils handles the rest-offset internally, but ONLY if both
//    skeletons are genuinely in their rest poses at call time. The hard part
//    moves to constructing a correct SMPL source skeleton + clip, not the math.
// ---------------------------------------------------------------------------
