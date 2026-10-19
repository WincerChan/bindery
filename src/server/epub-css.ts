import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Metadata } from "../core/models";
import { composeCss } from "../core/themes";
import { readArchive } from "../core/archive";
import { buildEpub, updateEpubMetadata } from "../core/epub";
import { strip } from "../core/python";
import { coverPath, epubPath, saveBook, sourcePath } from "./storage";
import { parseBookFile } from "./parsing";
import { getRule, getTheme } from "./templates";
import { effectiveThemeId } from "./book-view";
import { getLibrary } from "./runtime";
import { nowIso } from "./db";

export function composeBookCss(meta: Metadata): string {
  const theme = effectiveThemeId(meta);
  return composeCss(theme ? getTheme(theme)?.css : "", meta.custom_css);
}
const normalizeCss = (text: string) => strip(text.replaceAll("\r\n", "\n"));
interface IndexedCssSource {
  members: ReadonlyMap<string, unknown>;
  read(path: string): Uint8Array | undefined;
  cssChecked(css: string): boolean;
  markCssChecked(css: string): void;
}
export function bookEpubNeedsCssSync(data: Uint8Array | IndexedCssSource, meta: Metadata, css = composeBookCss(meta)): boolean {
  const entries = data instanceof Uint8Array ? readArchive(data) : null;
  const names = entries ? entries.map(entry => entry.name) : [...(data as IndexedCssSource).members.keys()];
  const read = (name: string) => entries ? entries.find(entry => entry.name === name)?.data : (data as IndexedCssSource).read(name);
  if (meta.source_type !== "epub") {
    const style = names.find(name => name === "EPUB/style.css") ?? names.find(name => name === "style.css" || name.endsWith("/style.css"));
    return !style || normalizeCss(new TextDecoder().decode(read(style))) !== normalizeCss(css);
  }
  const overlays = names.filter(name => ["/Styles/bindery.css", "/Styles/bindery-overlay.css", "/Text/bindery.css", "/bindery.css"].some(suffix => name.endsWith(suffix))).sort();
  if (!strip(css)) return overlays.length > 0;
  return !overlays.length || normalizeCss(new TextDecoder().decode(read(overlays[0]!))) !== normalizeCss(css);
}

/** Python _ensure_book_epub_css: lazy sync, preserving imported EPUB content. */
export function ensureBookEpubCss(meta: Metadata, library = getLibrary(), indexed?: IndexedCssSource): void {
  const path = epubPath(library.base, meta.book_id);
  if (!existsSync(path)) return;
  const css = composeBookCss(meta);
  if (indexed?.cssChecked(css)) return;
  if (!bookEpubNeedsCssSync(indexed ?? readFileSync(path), meta, css)) {
    indexed?.markCssChecked(css);
    return;
  }
  const original = readFileSync(path);
  let data: Uint8Array;
  let book: ReturnType<typeof parseBookFile> | undefined;
  if (meta.source_type === "epub") {
    data = updateEpubMetadata(original, meta, { css_text: css });
  } else {
    const cover = meta.cover_file ? { name: meta.cover_file, data: readFileSync(coverPath(library.base, meta.book_id, meta.cover_file)) } : null;
    const source = sourcePath(library.base, meta.book_id);
    if (existsSync(source)) {
      const rule = getRule(strip(meta.rule_template || "default") || "default");
      book = parseBookFile(source, meta.book_id, rule?.rules);
      data = buildEpub(book, meta, { cover, css_text: css });
    } else {
      data = updateEpubMetadata(original, meta, { cover, css_text: css });
    }
  }
  // Never leave a truncated EPUB if writing fails.
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, data);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  if (book) saveBook(book, library.base, meta.book_id);
  meta.status = "synced";
  meta.epub_updated_at = meta.updated_at = nowIso();
  library.saveMetadata(meta);
}
