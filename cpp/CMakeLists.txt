# Entrain motion core: C++ compiled to WebAssembly via Emscripten.
#
# Build with emcmake so the Emscripten toolchain file is used:
#   emcmake cmake -B build -S cpp -DCMAKE_BUILD_TYPE=Release
#   cmake --build build
# Emits build/entrain_core.js (ES6 module) + build/entrain_core.wasm.
# See cpp/build.sh for the wrapper the frontend build calls.

cmake_minimum_required(VERSION 3.13)
project(entrain_core CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# All sources. The math header is header-only.
add_executable(entrain_core
  api.cpp
  retarget.cpp
  cleanup.cpp
)

# Emit "<target>.js" rather than the default ".html". The matching .wasm is
# produced alongside it.
set_target_properties(entrain_core PROPERTIES OUTPUT_NAME "entrain_core" SUFFIX ".js")

# ES6 module that Vite can import. MODULARIZE wraps the glue in a factory;
# EXPORT_ES6 emits `export default`. ENVIRONMENT=web drops the Node/shell
# fallbacks. ALLOW_MEMORY_GROWTH lets the heap grow for large clips.
target_link_options(entrain_core PRIVATE
  "-sMODULARIZE=1"
  "-sEXPORT_ES6=1"
  "-sENVIRONMENT=web"
  "-sALLOW_MEMORY_GROWTH=1"
  "-sEXPORTED_RUNTIME_METHODS=['ccall','cwrap','HEAPF32','HEAP32']"
  "-sEXPORTED_FUNCTIONS=['_core_create','_setup','_set_params','_compute_all','_compute_frame','_get_out_local_quat','_get_out_root_pos','_get_frame_local_quat','_get_frame_root_pos','_core_free','_malloc','_free']"
)

# Release: optimize and enable WASM SIMD (the per-frame math vectorizes 4-wide).
# Debug: no opt, assertions, source maps for stepping through the math.
target_compile_options(entrain_core PRIVATE
  "$<$<CONFIG:Release>:-O3;-msimd128>"
  "$<$<CONFIG:Debug>:-O0;-g>"
)
target_link_options(entrain_core PRIVATE
  "$<$<CONFIG:Release>:-O3;-msimd128>"
  "$<$<CONFIG:Debug>:-O0;-g;-sASSERTIONS=1>"
)
