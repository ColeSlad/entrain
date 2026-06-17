// Exported WASM entrypoints called from JS. Phase 0 is a trivial add() used
// only to prove the emsdk + CMake + Vite interop end to end. The real motion
// API (setup / compute_all / compute_frame / set_params / free) lands in later
// phases. EMSCRIPTEN_KEEPALIVE plus extern "C" keeps the symbol unmangled so JS
// can ccall("add", ...) it directly.

#include <emscripten/emscripten.h>

extern "C" {

EMSCRIPTEN_KEEPALIVE
int add(int a, int b) {
  return a + b;
}

}
