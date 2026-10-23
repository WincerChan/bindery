import type { Metadata } from "../../core/models";
import { normalizeIdentity } from "../../core/identity";
import type { LibraryStorage } from "../storage";
import { ensureTrackerConsistencyForMeta } from "../tracker";

export { normalizeIdentity } from "../../core/identity";
export const safeFilename = (s: string) => s.replace(/[^0-9a-zA-Z\u4e00-\u9fff]+/g, "_").replace(/^_+|_+$/g, "") || "book";
export function resolveTxtIdentity(name: string, title: string | null, author: string | null): [string, string | null] {
  const trim = (s: string) => s.replace(/^[\s\-_.，。;；:：]+|[\s\-_.，。;；:：]+$/g, "");
  const wrapped = /《\s*([^》]+?)\s*》/.exec(name)?.[1]?.trim();
  const marker = /(?:作者|作\s*者)\s*[:：]/.exec(name);
  const fallbackTitle = wrapped || trim((marker ? name.slice(0, marker.index) : name).replace(/[\(\[（【].*$/, ""));
  const fallbackAuthor = trim(/(?:作者|作\s*者)\s*[:：]\s*([^\(\[（【<《》]+)/.exec(name)?.[1] || "");
  const parsedTitle = (title || "").trim();
  return [normalizeIdentity(parsedTitle) ? parsedTitle : normalizeIdentity(fallbackTitle) ? fallbackTitle : parsedTitle || name.trim() || "未命名", (author || "").trim() || (normalizeIdentity(fallbackAuthor) ? fallbackAuthor : null)];
}
export function duplicateReason(title: string | null, author: string | null, isbn: string | null, existing: Metadata): string | null {
  const isbnKey = (s: string | null) => (s || "").replace(/[^0-9Xx]/g, "").toUpperCase();
  if (isbnKey(isbn) && isbnKey(isbn) === isbnKey(existing.isbn)) return "ISBN";
  if (!normalizeIdentity(title) || normalizeIdentity(title) !== normalizeIdentity(existing.title)) return null;
  const a = normalizeIdentity(author), b = normalizeIdentity(existing.author);
  return a && b ? a === b ? "标题+作者" : null : "标题";
}
export function duplicateBooks(library: LibraryStorage, title: string | null, author: string | null, isbn: string | null) {
  return library.listBooks().flatMap(meta => {
    const reason = duplicateReason(title, author, isbn, meta);
    return reason ? [{ book_id: meta.book_id, title: meta.title, author: meta.author || "未知", reason }] : [];
  }).slice(0, 3);
}
export function ensureTracker(library: LibraryStorage, meta: Metadata): void {
  ensureTrackerConsistencyForMeta(meta, library);
}
