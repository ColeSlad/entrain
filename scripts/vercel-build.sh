#!/usr/bin/env bash
# Build from source in Vercel's Linux container. Local verification can reuse an
# existing SDK with: EMSDK=/path/to/emsdk bash scripts/vercel-build.sh
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMSCRIPTEN_VERSION="6.0.0"
NODE_BIN_DIR="$(dirname "$(command -v node)")"
cd "$PROJECT_ROOT"

# Vercel's Amazon Linux build image has make, git, and Python, but not CMake.
if ! command -v cmake >/dev/null 2>&1; then
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y cmake
  else
    echo "error: install CMake before running this build (see docs/SETUP.md)" >&2
    exit 1
  fi
fi

if [ -n "${EMSDK:-}" ]; then
  ENTRAIN_SDK_DIR="$EMSDK"
else
  # A fresh directory avoids depending on previous deployment caches or
  # changing a developer's SDK. Nothing here is part of the published output.
  ENTRAIN_SDK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/entrain-emsdk.XXXXXX")"
  git clone --depth 1 --branch "$EMSCRIPTEN_VERSION" \
    https://github.com/emscripten-core/emsdk.git "$ENTRAIN_SDK_DIR"
  "$ENTRAIN_SDK_DIR/emsdk" install "$EMSCRIPTEN_VERSION"
  "$ENTRAIN_SDK_DIR/emsdk" activate "$EMSCRIPTEN_VERSION"
fi

# shellcheck disable=SC1091
source "$ENTRAIN_SDK_DIR/emsdk_env.sh"
# emsdk adds its own Node to PATH. Keep Vercel's selected Node for npm/Vite.
export PATH="$NODE_BIN_DIR:$PATH"
if [ "$(emcc -dumpversion)" != "$EMSCRIPTEN_VERSION" ]; then
  echo "error: this build requires Emscripten $EMSCRIPTEN_VERSION" >&2
  exit 1
fi

emcc --version
cmake --version
npm --prefix frontend run build
npm --prefix frontend run test
