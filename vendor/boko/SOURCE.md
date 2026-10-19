# boko WASM

Prebuilt WebAssembly build of [boko](https://github.com/zacharydenton/boko) used to convert EPUB to KFX in the browser.

- Crate: `boko` 0.5.0 from crates.io (source: https://crates.io/crates/boko/0.5.0, repository https://github.com/zacharydenton/boko)
- License: GPL-3.0-or-later, see `LICENSE` in this directory. These files are distributed to browsers; the corresponding source is the crate above.
- Built with Rust 1.93, target `wasm32-unknown-unknown`, `--no-default-features --features wasm`, release profile overrides `lto=thin`, `codegen-units=1`, `overflow-checks=true`, `panic=abort`; bindings by `wasm-bindgen` 0.2.108 (`--target web`). No `wasm-opt`.
- Rebuild: `scripts/build-boko-wasm.sh`.

| File | sha256 |
|---|---|
| `boko_bg.wasm` | `e50c279ce8c97b86abcf668b7dcc2534d93b2782f194b67a23b4b776b5554811` |
| `boko.js` | `738797303669e53c45c050537640d5535d8c54072b8770a78064e5b080c0d3cc` |

Exports: `convert(data, from, to)`, `book_info(data, from)`.

Note: the KFX container ID depends on pointer width, so KFX produced by this WASM build differs by ~140 bytes (container ID and its derived SHA-1 only) from the native 64-bit CLI. Use only this build for KFX so IDs stay stable.
