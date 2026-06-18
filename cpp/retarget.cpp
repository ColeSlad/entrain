// SMPL to Mixamo retarget in C++: forward kinematics, the coordinate fix, the
// rest-pose correction, and pelvis stabilization. This is the port of the
// rotation half of frontend/src/core/retargetCore.ts; the position-based
// cleanup (grounding, foot-lock) lands in cleanup.cpp (Phase 4). Output and
// math must match the TS oracle within the parity gate.

#include "core.hpp"

namespace mc {

// SMPL 24-joint tree, parent index (-1 root), parent before child.
static const int SMPL_PARENTS[24] = {
  -1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19, 20, 21,
};

static quat read_quat(const float* buf, int i) {
  int o = i * 4;
  return {buf[o], buf[o + 1], buf[o + 2], buf[o + 3]};
}

static void write_quat(float* buf, int i, const quat& q) {
  int o = i * 4;
  buf[o] = q.x; buf[o + 1] = q.y; buf[o + 2] = q.z; buf[o + 3] = q.w;
}

static int depth(const Core& c, int b) {
  int d = 0;
  for (int p = c.parentIndex[b]; p >= 0; p = c.parentIndex[p]) d++;
  return d;
}

void core_setup_derived(Core& c) {
  const int n = c.numBones;

  // Rest-pose FK for the world rotations (tgtRest). Pre-order guarantees the
  // parent is done first.
  c.bindWorldRot.assign(n, quat{0, 0, 0, 1});
  for (int i = 0; i < n; i++) {
    quat local = read_quat(c.restLocalQuat, i);
    int p = c.parentIndex[i];
    c.bindWorldRot[i] = p < 0 ? local : quat_mul(c.bindWorldRot[p], local);
  }

  // Which bones are mapped, and the processing order (parent before child).
  c.mappedSmpl.assign(n, -1);
  c.order.clear();
  c.orderSmpl.clear();
  struct Entry { int bone, smpl, depth; };
  std::vector<Entry> entries;
  for (int j = 0; j < 24; j++) {
    int b = c.smplToTarget[j];
    if (b < 0) continue;
    c.mappedSmpl[b] = j;
    entries.push_back({b, j, depth(c, b)});
  }
  // Stable insertion sort by depth (small N; keeps ties in SMPL order).
  for (size_t i = 1; i < entries.size(); i++) {
    Entry e = entries[i];
    size_t k = i;
    while (k > 0 && entries[k - 1].depth > e.depth) { entries[k] = entries[k - 1]; k--; }
    entries[k] = e;
  }
  for (const auto& e : entries) { c.order.push_back(e.bone); c.orderSmpl.push_back(e.smpl); }

  core_compute_ground(c); // rest floor height (needs bindWorldRot, above)
  core_update_params(c);  // coord-fix inverse + foot-lock path
}

void core_update_params(Core& c) {
  c.coordFixInv = quat_conj(c.params.coordFix);
  core_compute_root_path(c); // depends on rotations (coordFix) and params
}

// SMPL local axis-angle (length 72) -> per-joint world rotations, coordinate
// fix premultiplied. Raw FK first, then the fix in a second pass (folding it
// into the loop would compound it down the tree).
static void smpl_anim_globals(const Core& c, int frame, quat* out) {
  const float* p = c.smplPoses + (size_t)frame * 72;
  quat local[24], raw[24];
  for (int j = 0; j < 24; j++) local[j] = quat_from_axis_angle(p[j * 3], p[j * 3 + 1], p[j * 3 + 2]);
  for (int j = 0; j < 24; j++) {
    int par = SMPL_PARENTS[j];
    raw[j] = par == -1 ? local[j] : quat_mul(raw[par], local[j]);
  }
  for (int j = 0; j < 24; j++) out[j] = quat_mul(c.params.coordFix, raw[j]);
}

// Keep yaw, scale pitch/roll toward zero by rootUpright (pelvis upright).
static quat stabilize(const Core& c, const quat& q) {
  euler3 e = euler_yxz_from_quat(q);
  float k = 1.0f - c.params.rootUpright;
  return quat_from_euler_yxz(e.x * k, e.y, e.z * k);
}

void core_retarget_frame(const Core& c, int frame, float* outLocal) {
  const int n = c.numBones;
  // Unmapped bones hold their rest local rotation.
  for (int i = 0; i < n * 4; i++) outLocal[i] = c.restLocalQuat[i];

  quat anim[24];
  smpl_anim_globals(c, frame, anim);

  std::vector<quat> desiredWorld(n);
  const float up = c.params.rootUpright;
  for (size_t k = 0; k < c.order.size(); k++) {
    int bone = c.order[k];
    int smpl = c.orderSmpl[k];
    // desired world = srcAnim * srcRestInv * tgtRest. SMPL rests at identity,
    // so srcRestInv is the coordinate-fix inverse for every bone.
    quat desired = quat_mul(quat_mul(anim[smpl], c.coordFixInv), c.bindWorldRot[bone]);
    desiredWorld[bone] = desired;
    // The pelvis is localized upright; the lean stays in the hips local rotation
    // so the body below de-leans with it.
    quat apply = (smpl == 0 && up > 0.0f) ? stabilize(c, desired) : desired;
    int p = c.parentIndex[bone];
    quat parentWorld;
    if (p >= 0 && c.mappedSmpl[p] >= 0) parentWorld = desiredWorld[p];
    else if (p >= 0) parentWorld = c.bindWorldRot[p];
    else parentWorld = quat{0, 0, 0, 1};
    write_quat(outLocal, bone, quat_mul(quat_conj(parentWorld), apply));
  }
}

}  // namespace mc
