#pragma once
// Shared state for the motion core. api.cpp owns the exported entrypoints and a
// single Core instance; retarget.cpp (and later cleanup.cpp) implement the math
// over it. Skeleton and motion arrays live in the WASM heap and are owned by JS;
// the Core just holds the pointers it was handed in setup().

#include <cstdint>
#include <vector>
#include "math.hpp"

namespace mc {

struct Params {
  float rootUpright = 1.0f; // keep yaw, scale pitch/roll toward zero on the Hips
  float footLock = 1.0f;
  float recenterWin = 61.0f;
  quat coordFix = {0, 0, 0, 1};
};

struct Core {
  // Skeleton (heap pointers owned by JS).
  int numBones = 0;
  const int32_t* parentIndex = nullptr;   // [numBones], -1 for root
  const float* restLocalQuat = nullptr;   // [numBones*4] xyzw
  const float* restLocalPos = nullptr;    // [numBones*3]
  const int32_t* smplToTarget = nullptr;  // [24], target bone per SMPL joint
  const int32_t* footBones = nullptr;     // [numFootBones]
  int numFootBones = 0;
  int lockL = -1, lockR = -1;             // LeftFoot / RightFoot bone indices

  // Motion (heap pointers owned by JS).
  int numFrames = 0;
  int fps = 30;
  const float* smplPoses = nullptr;       // [numFrames*72]
  const float* rootTranslation = nullptr; // [numFrames*3]
  const float* footContact = nullptr;     // [numFrames*4]

  Params params;
  quat coordFixInv = {0, 0, 0, 1};

  // Derived from the skeleton (built in setup).
  std::vector<quat> bindWorldRot;  // [numBones], rest world rotations (tgtRest)
  std::vector<int> mappedSmpl;     // [numBones], source SMPL joint or -1
  std::vector<int> order;          // mapped bone indices, parent before child
  std::vector<int> orderSmpl;      // SMPL joint per entry of order
  float groundY = 0.0f;            // load-time lowest foot world Y (the floor)
  std::vector<float> rootPath;     // [numFrames*2], foot-lock x,z, high-passed

  // Output buffers (heap, read back by JS as HEAPF32 views).
  std::vector<float> outLocalQuat;   // [numFrames*numBones*4]
  std::vector<float> outRootPos;     // [numFrames*3]
  std::vector<float> frameLocalQuat; // [numBones*4], for compute_frame
  std::vector<float> frameRootPos;   // [3]
};

// Build bindWorldRot and the processing order from the skeleton (skeleton only).
void core_setup_derived(Core& c);
// Refresh anything derived from params (coordinate-fix inverse + foot-lock path).
void core_update_params(Core& c);
// Retarget one frame into outLocal (length numBones*4): SMPL FK, coordinate
// fix, rest-pose correction, pelvis stabilization.
void core_retarget_frame(const Core& c, int frame, float* outLocal);

// Cleanup (cleanup.cpp): rest-pose floor height, the per-clip foot-lock path,
// and the grounded + foot-locked root position for a frame given its retargeted
// local rotations. These need target-skeleton world-position FK.
void core_compute_ground(Core& c);
void core_compute_root_path(Core& c);
void core_cleanup_frame(const Core& c, int frame, const float* localQuat, float* outRoot3);

}  // namespace mc
