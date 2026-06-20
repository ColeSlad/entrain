// Exported WASM entrypoints. JS resolves the skeleton to indices and flat heap
// arrays, calls setup() + set_params() once per clip, compute_all() to fill the
// output buffers, then reads them back through HEAPF32 views at the pointers the
// getters return. No strings cross the boundary; pointers are passed as ints
// (Emscripten heap offsets).
//
// The module holds many independent cores so one WASM instance can drive many
// dancers (Phase 6). core_create() returns an integer handle; every other call
// takes that handle first. compute_all writes target-bone LOCAL rotations plus
// the grounded, foot-locked root position; compute_frame reposes a single frame.

#include <cstdint>
#include <vector>

#include <emscripten/emscripten.h>
#include "core.hpp"

using namespace mc;

// Handle table. A handle is an index; freed slots are reused. Pointers stay
// stable because the Cores are heap-allocated, not stored by value.
static std::vector<Core*> g_cores;

static Core& core(int h) { return *g_cores[h]; }

extern "C" {

EMSCRIPTEN_KEEPALIVE
int core_create() {
  for (size_t i = 0; i < g_cores.size(); i++) {
    if (!g_cores[i]) { g_cores[i] = new Core(); return static_cast<int>(i); }
  }
  g_cores.push_back(new Core());
  return static_cast<int>(g_cores.size() - 1);
}

EMSCRIPTEN_KEEPALIVE
void setup(int h, int numBones, int parentIndexPtr, int restLocalQuatPtr, int restLocalPosPtr,
           int smplToTargetPtr, int footBonesPtr, int numFootBones, int lockL, int lockR,
           int numFrames, int fps, int smplPosesPtr, int rootTranslationPtr, int footContactPtr) {
  Core& c = core(h);
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

  // Only the per-frame buffers are allocated here. The full-clip buffer is sized
  // lazily in compute_all, so a field of many dancers driven by compute_frame
  // pays no per-clip memory (just the foot-lock path, sized in setup_derived).
  c.frameLocalQuat.assign(static_cast<size_t>(numBones) * 4, 0.0f);
  c.frameRootPos.assign(3, 0.0f);

  core_setup_derived(c);
}

EMSCRIPTEN_KEEPALIVE
void set_params(int h, float rootUpright, float footLock, float recenterWin,
                float cfx, float cfy, float cfz, float cfw) {
  Core& c = core(h);
  c.params = Params{rootUpright, footLock, recenterWin, quat{cfx, cfy, cfz, cfw}};
  core_update_params(c);
}

EMSCRIPTEN_KEEPALIVE
void compute_all(int h) {
  Core& c = core(h);
  const int n = c.numBones;
  const size_t nq = static_cast<size_t>(c.numFrames) * n * 4;
  if (c.outLocalQuat.size() != nq) {
    c.outLocalQuat.assign(nq, 0.0f);
    c.outRootPos.assign(static_cast<size_t>(c.numFrames) * 3, 0.0f);
  }
  for (int f = 0; f < c.numFrames; f++) {
    float* local = &c.outLocalQuat[static_cast<size_t>(f) * n * 4];
    core_retarget_frame(c, f, local);
    core_cleanup_frame(c, f, local, &c.outRootPos[f * 3]);
  }
}

EMSCRIPTEN_KEEPALIVE
void compute_frame(int h, int frame) {
  Core& c = core(h);
  const int N = c.numFrames;
  int f = ((frame % N) + N) % N;
  core_retarget_frame(c, f, c.frameLocalQuat.data());
  core_cleanup_frame(c, f, c.frameLocalQuat.data(), c.frameRootPos.data());
}

EMSCRIPTEN_KEEPALIVE int get_out_local_quat(int h) { return static_cast<int>(reinterpret_cast<intptr_t>(core(h).outLocalQuat.data())); }
EMSCRIPTEN_KEEPALIVE int get_out_root_pos(int h) { return static_cast<int>(reinterpret_cast<intptr_t>(core(h).outRootPos.data())); }
EMSCRIPTEN_KEEPALIVE int get_frame_local_quat(int h) { return static_cast<int>(reinterpret_cast<intptr_t>(core(h).frameLocalQuat.data())); }
EMSCRIPTEN_KEEPALIVE int get_frame_root_pos(int h) { return static_cast<int>(reinterpret_cast<intptr_t>(core(h).frameRootPos.data())); }

EMSCRIPTEN_KEEPALIVE
void core_free(int h) {
  if (h >= 0 && h < static_cast<int>(g_cores.size()) && g_cores[h]) {
    delete g_cores[h];
    g_cores[h] = nullptr;
  }
}

}  // extern "C"
