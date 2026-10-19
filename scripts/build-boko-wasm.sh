#!/usr/bin/env bash
# Rebuild vendor/boko from the boko 0.5.0 crate (GPL-3.0-or-later).
# Requires: rustup target wasm32-unknown-unknown, network access for the first crate fetch.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${BOKO_BUILD_DIR:-"$(mktemp -d)"}
BOKO_VERSION=0.5.0
WASM_BINDGEN_VERSION=0.2.108

rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version "$WASM_BINDGEN_VERSION" --locked --root "$WORK/tools"

cd "$WORK"
curl -fsSL "https://crates.io/api/v1/crates/boko/$BOKO_VERSION/download" -o boko.crate
tar -xzf boko.crate
cd "boko-$BOKO_VERSION"

export CARGO_PROFILE_RELEASE_LTO=thin
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
export CARGO_PROFILE_RELEASE_OVERFLOW_CHECKS=true
export CARGO_PROFILE_RELEASE_PANIC=abort
export CARGO_TARGET_DIR="$WORK/target"
cargo build --locked --release --lib --target wasm32-unknown-unknown --no-default-features --features wasm
"$WORK/tools/bin/wasm-bindgen" --target web --out-dir "$WORK/pkg" "$WORK/target/wasm32-unknown-unknown/release/boko.wasm"

cp "$WORK/pkg/boko_bg.wasm" "$WORK/pkg/boko_bg.wasm.d.ts" "$WORK/pkg/boko.js" "$WORK/pkg/boko.d.ts" "$ROOT/vendor/boko/"
cp LICENSE "$ROOT/vendor/boko/LICENSE"
(cd "$ROOT/vendor/boko" && sha256sum boko_bg.wasm boko.js)
