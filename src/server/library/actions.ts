import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { strip } from "../../core/python";
import { writeArchive } from "../../core/archive";
import { nowIso } from "../db";
import { ensureBookEpubCss } from "../epub-css";
import { downloadFilename } from "../files";
import { HttpError } from "../http";
import { enqueueJob } from "../jobs";
import { bookView } from "../book-view";
import { epubPath, type LibraryStorage } from "../storage";

export function normalizeBookIds(ids: string[]): string[] {
  return [...new Set(ids.map(strip).filter(id => /^[a-f0-9]{32}$/.test(id)))];
}
export async function formBookIds(request: Request): Promise<string[]> {
  const form = await request.formData();
  return normalizeBookIds(form.getAll("book_ids").filter((value): value is string => typeof value === "string"));
}
export function archiveBooks(ids: string[], library: LibraryStorage): number {
  let changed = 0;
  for (const id of normalizeBookIds(ids)) {
    if (!library.ensureBookExists(id)) continue;
    const meta = library.loadMetadata(id);
    meta.archived = true;
    meta.updated_at = nowIso();
    library.saveMetadata(meta);
    library.archiveBook(id);
    changed++;
  }
  return changed;
}
export function deleteArchivedBooks(ids: string[], library: LibraryStorage): number {
  let changed = 0;
  for (const id of normalizeBookIds(ids)) {
    if (!existsSync(join(library.base, "archive", id))) continue;
    library.deleteBook(id);
    changed++;
  }
  return changed;
}
export function restoreArchivedBooks(ids: string[] | null, library: LibraryStorage): number {
  if (!ids) throw new HttpError(400, "书籍参数错误");
  let changed = 0;
  const selected = normalizeBookIds(ids).filter(id => existsSync(join(library.base, "archive", id)));
  // Validate all destinations before moving any selected book.
  for (const id of selected) {
    if (existsSync(join(library.base, id))) throw new HttpError(409, "书籍已存在");
    library.loadMetadata(id);
  }
  for (const id of selected) { library.restoreBook(id); changed++; }
  return changed;
}
export function downloadBooks(ids: string[], library: LibraryStorage, date = new Date()): Response {
  const selected = normalizeBookIds(ids);
  if (!selected.length) throw new HttpError(400, "未选择书籍");
  const entries: { name: string; data: Uint8Array }[] = [], used = new Set<string>();
  for (const id of selected) {
    if (!library.ensureBookExists(id)) continue;
    const meta = library.loadMetadata(id);
    ensureBookEpubCss(meta, library);
    const path = epubPath(library.base, id);
    if (!existsSync(path)) continue;
    const filename = downloadFilename(meta), basename = filename.slice(0, -5);
    let name = filename, suffix = 2;
    while (used.has(name)) name = `${basename}-${suffix++}.epub`;
    used.add(name);
    entries.push({ name, data: readFileSync(path) });
  }
  if (!entries.length) throw new HttpError(404, "未找到可下载的 EPUB");
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return new Response(Buffer.from(writeArchive(entries)), { headers: {
    "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="bindery-books-${stamp}.zip"`, "Cache-Control": "no-store",
  } });
}
export function regenerateBooks(ids: string[] | null, library: LibraryStorage) {
  if (!ids) throw new HttpError(400, "书籍参数错误");
  let queued = 0, failed = 0, skipped = 0;
  for (const id of normalizeBookIds(ids)) {
    if (!library.ensureBookExists(id)) { skipped++; continue; }
    const meta = library.loadMetadata(id);
    if (!bookView(meta, library).can_regenerate) { skipped++; continue; }
    const result = enqueueJob({ book_id: id, action: "regenerate", rule_template: strip(meta.rule_template || "default") || "default" }, library);
    if (result.queued) queued++; else failed++;
  }
  return { queued, failed, skipped };
}
