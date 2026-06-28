#!/usr/bin/env bash
# Build the large fixture: downloads the sqlite3 amalgamation if absent, then
# compiles large.cpp + sqlite3.c with emscripten. Produces a multi-MB wasm with
# DWARF debug info and thousands of real sqlite symbols for testing attach time
# and symbol-search performance.
#
# Usage (from repo root):
#   EMSDK=~/src/emsdk npm run build:fixture-large
# Or directly:
#   EMSDK=~/src/emsdk bash scripts/build-fixture-large.sh

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test/fixtures/large"
SQLITE_VERSION="3470200"
SQLITE_ZIP="sqlite-amalgamation-${SQLITE_VERSION}.zip"
SQLITE_URL="https://www.sqlite.org/2024/${SQLITE_ZIP}"
EMCC="${EMSDK:+${EMSDK}/upstream/emscripten/}emcc"

if ! command -v "$EMCC" &>/dev/null 2>&1; then
  echo "error: emcc not found (set EMSDK or ensure emcc is on PATH)" >&2
  exit 1
fi

cd "$DIR"

if [ ! -f sqlite3.c ]; then
  echo "Downloading sqlite3 amalgamation ${SQLITE_VERSION}..."
  TMP=$(mktemp -d)
  trap "rm -rf $TMP" EXIT
  curl -fsSL "$SQLITE_URL" -o "$TMP/$SQLITE_ZIP"
  unzip -q "$TMP/$SQLITE_ZIP" -d "$TMP"
  cp "$TMP/sqlite-amalgamation-${SQLITE_VERSION}/sqlite3.c" .
  cp "$TMP/sqlite-amalgamation-${SQLITE_VERSION}/sqlite3.h" .
  echo "sqlite3 downloaded."
fi

echo "Compiling large fixture..."
"$EMCC" large.cpp sqlite3.c -o large.js \
  -g -O1 \
  -DSQLITE_OMIT_LOAD_EXTENSION \
  -DSQLITE_DEFAULT_MEMSTATUS=0 \
  -DSQLITE_OMIT_DEPRECATED \
  -s EXPORTED_RUNTIME_METHODS='["cwrap","ccall"]' \
  -s MODULARIZE=1 \
  -s EXPORT_NAME=LargeModule \
  -s ALLOW_MEMORY_GROWTH=1
echo "Done: large.wasm $(du -sh large.wasm | cut -f1)"
