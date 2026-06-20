// Cleanup passes in C++: grounding (clamp the lowest foot to the floor) and the
// foot-lock path (keep the planted foot horizontally fixed, high-passed so the
// dancer does not drift). Both need target-skeleton world POSITIONS, so this
// does position forward kinematics. Port of the position half of
// frontend/src/core/retargetCore.ts (fkPositions, computeBind, computeRootPath,
// minFootY, and the per-frame root placement). Pelvis stabilization already
// happens in retarget.cpp.

#include <vector>

#include "core.hpp"

namespace mc {

static quat read_quat(const float* buf, int i) {
  int o = i * 4;
  return {buf[o], buf[o + 1], buf[o + 2], buf[o + 3]};
}

// Position FK with the root translation at the origin, using the given per-frame
// local rotations. Fills worldRot/worldPos (each sized numBones). Pre-order
// guarantees the parent is done first.
static void fk_positions(const Core& c, const float* localQuat,
                         std::vector<quat>& worldRot, std::vector<vec3>& worldPos) {
  const int n = c.numBones;
  for (int i = 0; i < n; i++) {
    int p = c.parentIndex[i];
    quat local = read_quat(localQuat, i);
    float lx = c.restLocalPos[i * 3], ly = c.restLocalPos[i * 3 + 1], lz = c.restLocalPos[i * 3 + 2];
    if (p < 0) {
      worldRot[i] = local;
      worldPos[i] = {0.0f, 0.0f, 0.0f};
    } else {
      worldRot[i] = quat_mul(worldRot[p], local);
      vec3 r = apply_quat(worldRot[p], lx, ly, lz);
      worldPos[i] = {worldPos[p].x + r.x, worldPos[p].y + r.y, worldPos[p].z + r.z};
    }
  }
}

static float min_foot_y(const Core& c, const std::vector<vec3>& worldPos) {
  if (c.numFootBones == 0) return 0.0f;
  float m = worldPos[c.footBones[0]].y;
  for (int i = 1; i < c.numFootBones; i++) m = std::min(m, worldPos[c.footBones[i]].y);
  return m;
}

// Rest-pose floor height: rest FK positions with the root at its true rest
// position, lowest foot Y. The per-frame pass zeroes the root, so this carries
// the rig's load-time world offset (matches the TS computeBind / groundToFeet).
void core_compute_ground(Core& c) {
  const int n = c.numBones;
  std::vector<vec3> worldPos(n);
  for (int i = 0; i < n; i++) {
    int p = c.parentIndex[i];
    float lx = c.restLocalPos[i * 3], ly = c.restLocalPos[i * 3 + 1], lz = c.restLocalPos[i * 3 + 2];
    if (p < 0) {
      worldPos[i] = {lx, ly, lz};
    } else {
      vec3 r = apply_quat(c.bindWorldRot[p], lx, ly, lz);
      worldPos[i] = {worldPos[p].x + r.x, worldPos[p].y + r.y, worldPos[p].z + r.z};
    }
  }
  c.groundY = c.numFootBones == 0 ? 0.0f : worldPos[c.footBones[0]].y;
  for (int i = 1; i < c.numFootBones; i++) c.groundY = std::min(c.groundY, worldPos[c.footBones[i]].y);
}

// Centered moving average over an [N*2] (x,z) signal (matches Viewer.movingAvg).
static std::vector<float> moving_avg2(const std::vector<float>& p, int n, int win) {
  int half = (win - 1) / 2;
  std::vector<float> out(n * 2);
  for (int i = 0; i < n; i++) {
    float sx = 0, sz = 0;
    int c = 0;
    int lo = std::max(0, i - half), hi = std::min(n - 1, i + half);
    for (int j = lo; j <= hi; j++) { sx += p[j * 2]; sz += p[j * 2 + 1]; c++; }
    out[i * 2] = sx / c;
    out[i * 2 + 1] = sz / c;
  }
  return out;
}

// Foot-lock path: lock the planted (lower) foot horizontally by offsetting the
// root, smoothed, then high-passed (subtract a slow RECENTER_WIN average) so the
// dancer steps in place without drifting off. Depends on rotations + params.
void core_compute_root_path(Core& c) {
  const int N = c.numFrames;
  c.rootPath.assign(N * 2, 0.0f);
  const int lf = c.lockL, rf = c.lockR;
  if (lf < 0 || rf < 0) return;

  std::vector<float> raw(N * 2);
  std::vector<float> local(c.numBones * 4);
  std::vector<quat> worldRot(c.numBones);
  std::vector<vec3> worldPos(c.numBones);
  float anchorX = 0, anchorZ = 0, offX = 0, offZ = 0;
  int prev = 0; // 0 = unset, 'L', 'R'
  for (int f = 0; f < N; f++) {
    core_retarget_frame(c, f, local.data());
    fk_positions(c, local.data(), worldRot, worldPos);
    float lx = worldPos[lf].x, ly = worldPos[lf].y, lz = worldPos[lf].z;
    float rx = worldPos[rf].x, ry = worldPos[rf].y, rz = worldPos[rf].z;
    bool supL = ly <= ry;
    float fx = supL ? lx : rx, fz = supL ? lz : rz;
    int cur = supL ? 'L' : 'R';
    if (cur != prev) { anchorX = fx + offX; anchorZ = fz + offZ; prev = cur; }
    offX = anchorX - fx;
    offZ = anchorZ - fz;
    raw[f * 2] = offX;
    raw[f * 2 + 1] = offZ;
  }
  std::vector<float> smoothed = moving_avg2(raw, N, 7);
  std::vector<float> drift = moving_avg2(smoothed, N, static_cast<int>(c.params.recenterWin));
  for (int i = 0; i < N; i++) {
    c.rootPath[i * 2] = smoothed[i * 2] - drift[i * 2];
    c.rootPath[i * 2 + 1] = smoothed[i * 2 + 1] - drift[i * 2 + 1];
  }
}

// Grounded + foot-locked root position for a frame, given its retargeted local
// rotations. Matches Viewer.poseAt: x/z from the foot-lock path scaled by
// footLock, y clamping the lowest foot to the floor.
void core_cleanup_frame(const Core& c, int frame, const float* localQuat, float* outRoot3) {
  std::vector<quat> worldRot(c.numBones);
  std::vector<vec3> worldPos(c.numBones);
  fk_positions(c, localQuat, worldRot, worldPos);
  const float lock = c.params.footLock;
  outRoot3[0] = c.rootPath[frame * 2] * lock;
  outRoot3[1] = c.numFootBones == 0 ? 0.0f : c.groundY - min_foot_y(c, worldPos);
  outRoot3[2] = c.rootPath[frame * 2 + 1] * lock;
}

}  // namespace mc
