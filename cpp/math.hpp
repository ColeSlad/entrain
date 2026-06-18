#pragma once
// Hand-rolled quaternion math for the motion core. The formulas match Three.js
// and the TS oracle (frontend/src/core/retargetCore.ts) exactly, because the
// empirical look depends on these exact operations, not just a "correct"
// rotation. Quaternions are xyzw throughout.
//
// Compute is single precision to match the HEAPF32 I/O and the SIMD goal
// (Phase 5). The TS oracle accumulates in double then stores float32; the
// resulting difference is well under the 1e-4 rad parity gate.

#include <cmath>

namespace mc {

struct quat { float x, y, z, w; };

// Axis-angle given as a rotation vector (axis * angle), the form SMPL pose
// triplets use. Matches THREE.setFromAxisAngle after normalizing the axis by
// its length (the angle); identity below a small epsilon.
inline quat quat_from_axis_angle(float x, float y, float z) {
  float a = std::sqrt(x * x + y * y + z * z);
  if (a < 1e-8f) return {0.0f, 0.0f, 0.0f, 1.0f};
  float half = a * 0.5f;
  float s = std::sin(half) / a; // dividing by a folds in the axis normalization
  return {x * s, y * s, z * s, std::cos(half)};
}

// a * b (THREE.Quaternion.multiplyQuaternions).
inline quat quat_mul(const quat& a, const quat& b) {
  return {
    a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y,
    a.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z,
    a.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x,
    a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

// Inverse of a unit quaternion is its conjugate (THREE.invert for unit quats).
inline quat quat_conj(const quat& q) { return {-q.x, -q.y, -q.z, q.w}; }

struct vec3 { float x, y, z; };

// Rotate a vector by a quaternion (THREE.Vector3.applyQuaternion). Used by the
// position FK that grounding and foot-lock need.
inline vec3 apply_quat(const quat& q, float vx, float vy, float vz) {
  float ix = q.w * vx + q.y * vz - q.z * vy;
  float iy = q.w * vy + q.z * vx - q.x * vz;
  float iz = q.w * vz + q.x * vy - q.y * vx;
  float iw = -q.x * vx - q.y * vy - q.z * vz;
  return {
    ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}

struct euler3 { float x, y, z; };  // pitch (x), yaw (y), roll (z)

// YXZ euler from a quaternion, via the rotation matrix elements the YXZ case
// needs (THREE.Euler.setFromQuaternion, order 'YXZ'). Used by pelvis
// stabilization: keep yaw, zero pitch and roll.
inline euler3 euler_yxz_from_quat(const quat& q) {
  float x = q.x, y = q.y, z = q.z, w = q.w;
  float x2 = x + x, y2 = y + y, z2 = z + z;
  float xx = x * x2, xy = x * y2, xz = x * z2;
  float yy = y * y2, yz = y * z2, zz = z * z2;
  float wx = w * x2, wy = w * y2, wz = w * z2;
  float m11 = 1 - (yy + zz), m13 = xz + wy, m21 = xy + wz, m22 = 1 - (xx + zz);
  float m23 = yz - wx, m31 = xz - wy, m33 = 1 - (xx + yy);
  float c = m23 < -1.0f ? -1.0f : (m23 > 1.0f ? 1.0f : m23);
  float ex = std::asin(-c);
  float ey, ez;
  if (std::fabs(m23) < 0.9999999f) { ey = std::atan2(m13, m33); ez = std::atan2(m21, m22); }
  else { ey = std::atan2(-m31, m11); ez = 0.0f; }
  return {ex, ey, ez};
}

// Quaternion from a YXZ euler (THREE.Quaternion.setFromEuler, order 'YXZ').
inline quat quat_from_euler_yxz(float ex, float ey, float ez) {
  float c1 = std::cos(ex * 0.5f), c2 = std::cos(ey * 0.5f), c3 = std::cos(ez * 0.5f);
  float s1 = std::sin(ex * 0.5f), s2 = std::sin(ey * 0.5f), s3 = std::sin(ez * 0.5f);
  return {
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 - s1 * s2 * c3,
    c1 * c2 * c3 + s1 * s2 * s3,
  };
}

}  // namespace mc
