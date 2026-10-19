import { readerArchives } from "./archive";
import { readFileSync, statSync } from "node:fs";
import { nowIso } from "../db";
import { ensureTrackerConsistencyForMeta } from "../tracker";
import { bookView } from "../book-view";
import { ensureBookEpubCss } from "../epub-css";
import { HttpError, requireBook } from "../http";
import { epubPath, type LibraryStorage } from "../storage";
import { readerReturnTo, type ReaderData } from "../../features/reader/model";
import { bigIntegerParameter } from "./parameters";

export const readerNoStoreHeaders = () => ({ "Cache-Control": "no-store, max-age=0", "CDN-Cache-Control": "no-store", Pragma: "no-cache", Expires: "0" });
export function readBookArchive(bookId: string, library: LibraryStorage) {
  const archive = readerArchives.get(epubPath(library.base, bookId));
  if (!archive) throw new HttpError(404, "EPUB 不存在");
  return archive;
}
// Kept for consumers that need a complete EPUB (e.g. typesetting/export).
export function readBookEpub(bookId: string, library: LibraryStorage): Uint8Array {
  const path = epubPath(library.base, bookId);
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) throw new HttpError(404, "EPUB 不存在");
  return readFileSync(path);
}
export function previewRedirect(request: Request, bookId: string, library: LibraryStorage): Response {
  requireBook(bookId, library);
  if (!readBookArchive(bookId, library).metadata().sections.length) throw new HttpError(404, "书籍没有章节");
  const query = new URLSearchParams({ resume: "1" });
  const target = readerReturnTo(new URL(request.url).searchParams.get("return_to"), "");
  if (target) query.set("return_to", target);
  return new Response(null, { status: 303, headers: { ...readerNoStoreHeaders(), Location: `/book/${bookId}/preview/0?${query}` } });
}
export function loadReader(bookId: string, rawSection: string, returnTo: unknown, library: LibraryStorage): ReaderData {
  const meta = requireBook(bookId, library);
  const tracker = ensureTrackerConsistencyForMeta(meta, library);
  ensureBookEpubCss(meta, library, readBookArchive(bookId, library));
  const sections = readBookArchive(bookId, library).metadata().sections;
  const rawIndex = bigIntegerParameter(rawSection);
  if (rawIndex === null) throw new HttpError(422, "请求参数无效");
  if (rawIndex < 0 || rawIndex >= sections.length) throw new HttpError(404, "章节不存在");
  const section = Number(rawIndex);
  const view = bookView(meta, library, tracker);
  return {
    book: { book_id: view.book_id, title: view.title, author: view.author, cover_url: view.cover_url },
    sections, section_index: section, initial_progress: library.db.getReaderProgress(bookId),
    return_to: readerReturnTo(returnTo),
  };
}
// Python int() accepts booleans, truncates numbers, and rejects decimal strings.
function decimalDigits(value: string): string {
  return value.replace(/\p{Decimal_Number}/gu, character => {
    const code = character.codePointAt(0)!;
    // Unicode decimal digits occur in consecutive groups of ten (some adjacent).
    let start = code;
    while (start > 0 && /\p{Decimal_Number}/u.test(String.fromCodePoint(start - 1))) start--;
    return String((code - start) % 10);
  });
}
export function progressInteger(value: unknown, minimum: number): number {
  let parsed: number;
  if (typeof value === "boolean") parsed = Number(value);
  else if (typeof value === "number" && Number.isFinite(value)) parsed = Math.trunc(value);
  else if (typeof value === "string") {
    const whitespace = "[\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
    const normalized = decimalDigits(value.replace(new RegExp(`^${whitespace}+|${whitespace}+$`, "g"), ""));
    if (!/^[+-]?\d(?:_?\d)*$/.test(normalized)) return 0;
    if (normalized.replace(/[+_-]/g, "").length > 4300) return 0;
    parsed = Number(normalized.replaceAll("_", ""));
  }
  else return 0;
  return Math.max(minimum, Math.min(999_999, parsed));
}
export async function saveProgress(request: Request, bookId: string, library: LibraryStorage): Promise<Response> {
  requireBook(bookId, library);
  let payload: unknown;
  try { payload = await request.json(); } catch { throw new HttpError(400, "Invalid JSON payload"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new HttpError(400, "Invalid JSON payload");
  const value = payload as Record<string, unknown>;
  const section = progressInteger(value.section, -1), page = progressInteger(value.page, 0), page_count = progressInteger(value.page_count, 0);
  library.db.upsertReaderProgress(bookId, section, page, page_count, nowIso());
  return Response.json({ ok: true, book_id: bookId, section, page, page_count });
}
