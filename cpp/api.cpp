// Exported WASM entrypoints. JS resolves the skeleton to indices and flat heap
// arrays, calls setup() + set_params() once per clip, compute_all() to fill the
// output buffers, then reads them back through HEAPF32 views at the pointers the
// getters return. No strings cross the boundary; pointers are passed as ints
// (Emscripten heap offsets). compute_frame() reposes a single frame for scrub.
//
// Phase 2 produces target-bone LOCAL rotations; the root position is passed
// through from the motion's pelvis translation (grounding and foot-lock are
// Phase 4). add() is the Phase 0 interop probe, removed once JS uses the core.

#include <cstdint>
#include <emscripten/emscripten.h>
#include "core.hpp"

using namespace mc;

static Core g_core;

extern "C" {

EMSCRIPTEN_KEEPALIVE
int add(int a, int b) { return a + b; }

EMSCRIPTEN_KEEPALIVE
void setup(int numBones, int parentIndexPtr, int restLocalQuatPtr, int restLocalPosPtr,
           int smplToTargetPtr, int footBonesPtr, int numFootBones, int lockL, int lockR,
           int numFrames, int fps, int smplPosesPtr, int rootTranslationPtr, int footContactPtr) {
  Core& c = g_core;
  c.numBones = numBones;
  c.parentIndex = reinterpret_cast<const int32_t*>(static_cast<intptr_t>(parentIndexPtr));
  c.restLocalQuat = reinterpret_cast<const float*>(static_cast<intptr_t>(restLocalQuatPtr));
  c.restLocalPos = reinterpret_cast<const float*>(static_cast<intptr_t>(restLocalPosPtr));
  c.smplToTarget = reinterpret_cast<const int32_t*>(static_cast<intptr_t>(smplToTargetPtr));
  c.footBones = reinterpret_cast<const int32_t*>(static_cast<intptr_t>(footBonesPtr));
  c.numFootBones = numFootBones;
  c.lockL = lockL;
  c.lockR = lockR;
  c.numFrames = numFrames;
  c.fps = fps;
  c.smplPoses = reinterpret_cast<const float*>(static_cast<intptr_t>(smplPosesPtr));
  c.rootTranslation = reinterpret_cast<const float*>(static_cast<intptr_t>(rootTranslationPtr));
  c.footContact = reinterpret_cast<const float*>(static_cast<intptr_t>(footContactPtr));

  c.outLocalQuat.assign(static_cast<size_t>(numFrames) * numBones * 4, 0.0f);
  c.outRootPos.assign(static_cast<size_t>(numFrames) * 3, 0.0f);
  c.frameLocalQuat.assign(static_cast<size_t>(numBones) * 4, 0.0f);
  c.frameRootPos.assign(3, 0.0f);

  core_setup_derived(c);
}

EMSCRIPTEN_KEEPALIVE
void set_params(float rootUpright, float footLock, float recenterWin,
                float cfx, float cfy, float cfz, float cfw) {
  g_core.params = Params{rootUpright, footLock, recenterWin, quat{cfx, cfy, cfz, cfw}};
  core_update_params(g_core);
}

EMSCRIPTEN_KEEPALIVE
void compute_all() {
  Core& c = g_core;
  const int n = c.numBones;
  for (int f = 0; f < c.numFrames; f++) {
    core_retarget_frame(c, f, &c.outLocalQuat[static_cast<size_t>(f) * n * 4]);
    // Phase 2: pass the pelvis translation through unchanged.
    c.outRootPos[f * 3 + 0] = c.rootTranslation[f * 3 + 0];
    c.outRootPos[f * 3 + 1] = c.rootTranslation[f * 3 + 1];
    c.outRootPos[f * 3 + 2] = c.rootTranslation[f * 3 + 2];
  }
}

EMSCRIPTEN_KEEPALIVE
void compute_frame(int frame) {
  Core& c = g_core;
  const int N = c.numFrames;
  int f = ((frame % N) + N) % N;
  core_retarget_frame(c, f, c.frameLocalQuat.data());
  c.frameRootPos[0] = c.rootTranslation[f * 3 + 0];
  c.frameRootPos[1] = c.rootTranslation[f * 3 + 1];
  c.frameRootPos[2] = c.rootTranslation[f * 3 + 2];
}

EMSCRIPTEN_KEEPALIVE int get_out_local_quat() { return static_cast<int>(reinterpret_cast<intptr_t>(g_core.outLocalQuat.data())); }
EMSCRIPTEN_KEEPALIVE int get_out_root_pos() { return static_cast<int>(reinterpret_cast<intptr_t>(g_core.outRootPos.data())); }
EMSCRIPTEN_KEEPALIVE int get_frame_local_quat() { return static_cast<int>(reinterpret_cast<intptr_t>(g_core.frameLocalQuat.data())); }
EMSCRIPTEN_KEEPALIVE int get_frame_root_pos() { return static_cast<int>(reinterpret_cast<intptr_t>(g_core.frameRootPos.data())); }

EMSCRIPTEN_KEEPALIVE
void core_free() { g_core = Core(); }

}  // extern "C"
