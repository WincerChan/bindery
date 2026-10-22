import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LibraryStorage } from "../storage";
import { queueDirectory } from "./staging";

export interface EditWritebackOptions {
  cover_bytes: Uint8Array | null;
  cover_name: string | null;
  cover_url: string;
  strip_original_css: boolean;
  /** One write-back only: remove embedded fonts and the book's own font-family rules (EPUB sources). */
  strip_fonts: boolean;
}
interface EditSpec {
  version: 1;
  kind: "edit-writeback";
  cover_name: string | null;
  cover_url: string;
  strip_original_css: boolean;
  // Absent in tasks staged before the option existed.
  strip_fonts?: boolean;
  has_cover: boolean;
}
export function stageEditWriteback(library: LibraryStorage, id: string, options: EditWritebackOptions): void {
  const directory = queueDirectory(library, id);
  mkdirSync(directory, { recursive: true });
  try {
    const spec: EditSpec = { version: 1, kind: "edit-writeback", cover_name: options.cover_name, cover_url: options.cover_url, strip_original_css: options.strip_original_css, strip_fonts: options.strip_fonts, has_cover: Boolean(options.cover_bytes?.length) };
    if (spec.has_cover) writeFileSync(join(directory, "cover"), options.cover_bytes!, { flag: "wx", flush: true });
    writeFileSync(join(directory, "task.json"), JSON.stringify(spec), { flag: "wx", flush: true });
    loadEditWriteback(library, id);
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}
export function loadEditWriteback(library: LibraryStorage, id: string): EditWritebackOptions {
  const directory = queueDirectory(library, id);
  const spec: EditSpec = JSON.parse(readFileSync(join(directory, "task.json"), "utf8"));
  if (spec.version !== 1 || spec.kind !== "edit-writeback" || typeof spec.cover_url !== "string" || typeof spec.strip_original_css !== "boolean" || spec.strip_fonts !== undefined && typeof spec.strip_fonts !== "boolean" || typeof spec.has_cover !== "boolean" || spec.cover_name !== null && typeof spec.cover_name !== "string") throw new Error("Invalid edit descriptor");
  const cover_bytes = spec.has_cover ? readFileSync(join(directory, "cover")) : null;
  if (spec.has_cover && !cover_bytes?.length) throw new Error("Empty staged cover");
  return { cover_bytes, cover_name: spec.cover_name, cover_url: spec.cover_url, strip_original_css: spec.strip_original_css, strip_fonts: spec.strip_fonts ?? false };
}
