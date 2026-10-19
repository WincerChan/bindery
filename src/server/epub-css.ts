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
export function bookEpubNeedsCssSync(data: Uint8Array, meta: Metadata, css = composeBookCss(meta)): boolean {
  const entries = readArchive(data);
  if (meta.source_type !== "epub") {
    const style = entries.find(e => e.name === "EPUB/style.css") ?? entries.find(e => e.name === "style.css" || e.name.endsWith("/style.css"));
    return !style || normalizeCss(new TextDecoder().decode(style.data)) !== normalizeCss(css);
  }
  const overlays = entries.filter(e => ["/Styles/bindery.css", "/Styles/bindery-overlay.css", "/Text/bindery.css", "/bindery.css"].some(s => e.name.endsWith(s))).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (!strip(css)) return overlays.length > 0;
  return !overlays.length || normalizeCss(new TextDecoder().decode(overlays[0]!.data)) !== normalizeCss(css);
}

/** Python _ensure_book_epub_css: lazy sync, preserving imported EPUB content. */
export function ensureBookEpubCss(meta: Metadata, library = getLibrary()): void {
  const path = epubPath(library.base, meta.book_id);
  if (!existsSync(path)) return;
  const original = readFileSync(path), css = composeBookCss(meta);
  if (!bookEpubNeedsCssSync(original, meta, css)) return;
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
