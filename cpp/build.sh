#!/usr/bin/env bash
# Build the WASM motion core and stage it for the frontend.
#
# Runs the Emscripten + CMake build and copies the emitted ES6 module into
# frontend/src/core/generated/ where Vite imports it. Called by the frontend's
# `build:wasm` npm script, so it must work regardless of the caller's cwd.
#
# Usage: cpp/build.sh [Release|Debug]   (defaults to Release)
set -euo pipefail

BUILD_TYPE="${1:-Release}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/frontend/src/core/generated"

# Put emcc/emcmake on PATH if they aren't already. emsdk_env.sh is noisy on
# stdout, so silence it. Override the location with EMSDK if installed elsewhere.
if ! command -v emcmake >/dev/null 2>&1; then
  EMSDK_DIR="${EMSDK:-$HOME/emsdk}"
  if [ -f "$EMSDK_DIR/emsdk_env.sh" ]; then
    # shellcheck disable=SC1091
    source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
  else
    echo "error: emcmake not found and no emsdk at $EMSDK_DIR (see docs/SETUP.md)" >&2
    exit 1
  fi
fi

emcmake cmake -B "$ROOT/build" -S "$ROOT/cpp" -DCMAKE_BUILD_TYPE="$BUILD_TYPE"
cmake --build "$ROOT/build"

mkdir -p "$OUT_DIR"
cp "$ROOT/build/entrain_core.js" "$ROOT/build/entrain_core.wasm" "$OUT_DIR/"
echo "wasm core -> $OUT_DIR (entrain_core.js, entrain_core.wasm)"
