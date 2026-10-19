/* tslint:disable */
/* eslint-disable */

/**
 * Inspect an ebook's metadata without converting it.
 *
 * `from` is the input format name (see [`convert`]). Returns a JSON string:
 * `{"title": ..., "authors": [...], "language": ..., "chapters": n, "toc_entries": n}`.
 * Call `JSON.parse` on the result in JavaScript.
 */
export function book_info(data: Uint8Array, from: string): any;

/**
 * Convert an ebook from one format to another.
 *
 * `from` and `to` are format names: `"epub"`, `"azw3"`, `"mobi"`, `"kfx"`,
 * or `"markdown"` (`"md"`). Any importable `from` (EPUB, AZW3, MOBI, KFX)
 * can be converted to any exportable `to` (EPUB, AZW3, KFX, Markdown).
 *
 * Takes the raw input bytes and returns the converted output bytes
 * (UTF-8 text for Markdown).
 */
export function convert(data: Uint8Array, from: string, to: string): Uint8Array;

/**
 * Initialize panic hook for better error messages in the browser console.
 */
export function init(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly book_info: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly convert: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly init: () => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
