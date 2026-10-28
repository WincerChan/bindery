import { randomBytes } from "node:crypto";
import type { Metadata, Wish } from "../../core/models";
import { strip } from "../../core/text";
import { BinderyDatabase, nowIso, transaction } from "../db";
import type { DatabaseSync } from "node:sqlite";
import { wishIdentity } from "../db/encoding";
import { HttpError, requireEntity, missingEntity } from "../http";
import type { LibraryStorage } from "../storage";

import { ensureTrackerForBook, syncTrackerMetadata } from "../tracker";
export { syncTrackerMetadata } from "../tracker";

const idPattern = /^[a-f0-9]{32}$/;
export const readLabel = (value: string) => value === "read" ? "已读" : value === "reading" ? "在读" : "未读";
export const statusLabel = (value: string) => value === "completed" ? "已完结" : value === "hiatus" ? "已断更" : "更新中";
const identity = (value: string | null) => wishIdentity(value, null)[0];
const normalized = (value: string, values: string[], fallback: string) => values.includes(strip(value).toLowerCase()) ? strip(value).toLowerCase() : fallback;
const bookId = (raw: string | null) => idPattern.test(strip(raw || "").toLowerCase()) ? strip(raw || "").toLowerCase() : null;
export function trackerFilters(search: Record<string, string>) {
  const rawLibrary = strip(search.library_filter || "").toLowerCase();
  return {
    q: search.q || "",
    read_filter: normalized(search.read_filter || "", ["unread", "reading", "read"], "all"),
    library_filter: ["in", "in_library"].includes(rawLibrary) ? "in" : ["out", "not_in_library"].includes(rawLibrary) ? "out" : "all",
    book_status_filter: normalized(search.book_status_filter || "", ["ongoing", "hiatus", "completed"], "all"),
  };
}
export function trackerUrl(search: Record<string, string>, page = 1, path = "/tracker") {
  const filters = trackerFilters(search), params = new URLSearchParams();
  if (strip(filters.q)) params.set("q", strip(filters.q));
  for (const key of ["read_filter", "library_filter", "book_status_filter"] as const) if (filters[key] !== "all") params.set(key, filters[key]);
  if (path === "/tracker" && page > 1) params.set("page", String(page));
  return path + (params.size ? `?${params}` : "");
}
export function safeTrackerNext(raw: string): string {
  const value = strip(raw);
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value)) return "/tracker";
  // legacy drops fragments and path parameters. Reject browser backslash redirects as well.
  const target = value.split("#", 1)[0]!;
  const q = target.indexOf("?");
  let path = q < 0 ? target : target.slice(0, q);
  const parameters = path.indexOf(";", path.lastIndexOf("/") + 1);
  if (parameters >= 0) path = path.slice(0, parameters);
  return path + (q < 0 ? "" : target.slice(q));
}
function duplicateUrl(next: string, id: string) {
  const target = new URL(safeTrackerNext(next), "http://bindery.invalid"), params = ["/tracker", "/wishlist"].includes(target.pathname) ? target.searchParams : new URLSearchParams();
  params.set("duplicate", id);
  return `/tracker?${params}`;
}
function libraryIdentity(books: Metadata[]) {
  const ids = new Set<string>(), titles = new Map<string, string>(), authors = new Map<string, string>();
  for (const book of books) {
    ids.add(book.book_id);
    const title = identity(book.title), author = identity(book.author);
    if (!title) continue;
    if (!titles.has(title)) titles.set(title, book.book_id);
    if (author && !authors.has(`${title}\0${author}`)) authors.set(`${title}\0${author}`, book.book_id);
  }
  return { ids, titles, authors };
}
function matchBook(wish: Wish, index: ReturnType<typeof libraryIdentity>) {
  const direct = bookId(wish.library_book_id);
  if (direct && index.ids.has(direct)) return direct;
  const key = identity(wish.title), author = identity(wish.author);
  if (!key) return null;
  return (author ? index.authors.get(`${key}\0${author}`) : index.titles.get(key)) || null;
}
export function trackerView(wish: Wish, libraryBookId: string | null) {
  const readStatus = normalized(wish.read_status || (wish.read ? "read" : "unread"), ["unread", "reading", "read"], "unread");
  const status = normalized(wish.book_status, ["hiatus", "completed"], "ongoing");
  const date = new Date(wish.updated_at);
  const display = Number.isNaN(date.valueOf()) ? wish.updated_at.replace("T", " ").replace("+00:00", " UTC").slice(0, 16) || "-" : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return { ...wish, read_status: readStatus, read: readStatus === "read", book_status: status, tags_text: wish.tags.filter(t => strip(t)).map(strip).join(", "), read_status_label: readLabel(readStatus), book_status_label: statusLabel(status), exists_in_library: Boolean(libraryBookId), exists_label: libraryBookId ? "已存在" : "未入库", library_book_id: libraryBookId, updated_at_display: display };
}
export type TrackerItem = ReturnType<typeof trackerView>;
export function trackerPayload(library: LibraryStorage, search: Record<string, string>) {
  const books = library.listBooks(), unlinked = new Map<string, Wish[]>();
  for (const wish of library.db.listWishes()) if (!bookId(wish.library_book_id)) {
    const key = identity(wish.title); unlinked.set(key, [...(unlinked.get(key) || []), wish]);
  }
  for (const meta of books) ensureTrackerForBook(meta, library, unlinked);
  const filters = trackerFilters(search), items: TrackerItem[] = [], reading_now: TrackerItem[] = [], index = libraryIdentity(books);
  const stats = { total: 0, filtered: 0, read: 0, reading: 0, unread: 0, in_library: 0, out_library: 0 };
  for (const wish of library.db.listWishes()) {
    const id = matchBook(wish, index);
    if (id && wish.library_book_id !== id) {
      const bound = library.db.getWishByLibraryBookId(id);
      if (!bound || bound.id === wish.id) { library.db.updateWish(wish.id, { library_book_id: id, updated_at: nowIso() }); wish.library_book_id = id; }
    }
    syncTrackerMetadata(library, wish, id);
    const item = trackerView(wish, id), query = strip(filters.q).toLowerCase();
    stats.total++; stats[item.read_status as "read" | "reading" | "unread"]++;
    // The intro is independent of directory filters and pagination; reuse this scan.
    if (item.read_status === "reading" && reading_now.length < 3) reading_now.push(item);
    if (id) stats.in_library++; else stats.out_library++;
    if (query && ![item.title, item.author || "", item.tags.join(" ")].some(v => v.toLowerCase().includes(query))) continue;
    if (filters.read_filter !== "all" && item.read_status !== filters.read_filter) continue;
    if (filters.library_filter === "in" && !id || filters.library_filter === "out" && id) continue;
    if (filters.book_status_filter !== "all" && item.book_status !== filters.book_status_filter) continue;
    items.push(item);
  }
  stats.filtered = items.length;
  return { filters, stats, items, index, reading_now };
}
export function trackerPage(library: LibraryStorage, search: Record<string, string>) {
  const { items, index, ...payload } = trackerPayload(library, search), totalPages = Math.max(1, Math.ceil(items.length / 20));
  const page = Math.min(totalPages, Math.max(1, Number.parseInt(search.page || "1", 10) || 1));
  const duplicate = bookId(search.duplicate || ""), wish = duplicate ? library.db.getWish(duplicate) : null;
  return { ...payload, wishes: items.slice((page - 1) * 20, page * 20), page, total_pages: totalPages, current_url: trackerUrl(search, page), export_url: trackerUrl(search, 1, "/tracker/export"), duplicate_notice: wish ? trackerView(wish, matchBook(wish, index)) : null };
}
export type TrackerPageData = ReturnType<typeof trackerPage>;
function duplicateItem(wish: Wish, author: string) {
  const id = bookId(wish.library_book_id), exact = Boolean(author && identity(wish.author) && identity(wish.author) === author);
  return { id: wish.id, title: wish.title || "未命名", author: wish.author || "", library_book_id: id || "", in_library: Boolean(id), exact_author: exact };
}
export function duplicateCheck(library: Pick<LibraryStorage, "db">, title: string, author: string, limit = 5) {
  const key = identity(title), authorKey = identity(author), wishes = library.db.listWishes(), safeLimit = Math.min(20, Math.max(1, limit));
  const compare = (a: { in_library: boolean; title: string; author: string }, b: typeof a) => Number(b.in_library) - Number(a.in_library) || (a.title < b.title ? -1 : a.title > b.title ? 1 : a.author < b.author ? -1 : a.author > b.author ? 1 : 0);
  const exact = key ? wishes.filter(w => identity(w.title) === key).map(w => { const item = duplicateItem(w, authorKey); return { ...item, blocking: authorKey ? item.exact_author : true }; }).sort((a, b) => Number(b.blocking) - Number(a.blocking) || compare(a, b)).slice(0, safeLimit) : [];
  const matches = strip(title) ? wishes.filter(w => strip(w.title).toLowerCase().includes(strip(title).toLowerCase())).map(w => duplicateItem(w, authorKey)).sort((a, b) => Number(b.exact_author) - Number(a.exact_author) || compare(a, b)).slice(0, safeLimit) : [];
  const blocking = exact.filter(item => item.blocking);
  return { exists: Boolean(blocking.length), rule: authorKey ? "title+author" : "title", matches, blocking_matches: blocking, exact_matches: exact };
}
export type DuplicateData = ReturnType<typeof duplicateCheck>;
// Reuse the shared CRUD/encoding API on one connection for an atomic manual merge.
class TrackerTransactionDatabase extends BinderyDatabase {
  constructor(path: string, private readonly connection: DatabaseSync) { super(path); }
  override withConnection<T>(fn: (conn: DatabaseSync) => T): T { return fn(this.connection); }
}
export function writeTracker(library: LibraryStorage, fields: Record<string, string>, id?: string): string {
  if (id && !idPattern.test(id)) missingEntity("wish");
  const existing = id ? library.db.getWish(id) : null;
  if (id) requireEntity(existing, "wish");
  const get = (key: string) => strip(fields[key] || "");
  let linked = bookId(get("library_book_id")) || (existing ? bookId(existing.library_book_id) : null);
  if (linked && !library.ensureBookExists(linked)) linked = null;
  const meta = linked ? library.loadMetadata(linked) : null, title = meta ? meta.title || "未命名" : get("title"), author = (meta ? meta.author : get("author")) || null;
  if (!title) throw new HttpError(400, "书名不能为空");
  const status = normalized(get("read_status") || (["1", "true", "yes", "on"].includes(get("read").toLowerCase()) ? "read" : "unread"), ["read", "reading"], "unread");
  const seen = new Set<string>(), firstTags = get("tags").split(/[，,\n]+/).map(strip).filter(t => { if (!t || seen.has(t.toLowerCase())) return false; seen.add(t.toLowerCase()); return true; });
  const ratingText = get("rating"), rating = /^[+-]?\d+$/.test(ratingText) ? Math.max(0, Math.min(5, Number(ratingText))) : null;
  const values = { title, author, library_book_id: linked, tags: firstTags, rating, comment: get("comment") || null, read_status: status, read: status === "read", book_status: normalized(get("book_status") || "completed", ["hiatus", "completed"], "ongoing"), updated_at: nowIso() };
  let duplicate: string | null = null, writtenId = id || randomBytes(16).toString("hex");
  // Reserve the writer before reading duplicates. A deferred read -> write
  // upgrade can fail immediately with SQLITE_BUSY while the job consumer writes,
  // bypassing busy_timeout because waiting would deadlock the two connections.
  library.db.withConnection(connection => transaction(connection, () => {
    const db = new TrackerTransactionDatabase(library.db.path, connection);
    if (!existing) {
      if (linked) duplicate = db.getWishByLibraryBookId(linked)?.id || null;
      else duplicate = duplicateCheck({ db }, title, author || "", 1).blocking_matches[0]?.id || null;
      if (duplicate) return;
    }
    const merge = existing && !linked ? db.getManualWishByIdentity(title, author, id) : null;
    if (merge) { db.updateWish(merge.id, values); db.deleteWish(id!); writtenId = merge.id; }
    else if (existing) db.updateWish(id!, values);
    else db.createWish({ ...values, id: writtenId, created_at: values.updated_at });
  }, "immediate"));
  if (duplicate) return duplicateUrl(get("next"), duplicate);
  const written = library.db.getWish(writtenId);
  if (written) syncTrackerMetadata(library, written);
  return safeTrackerNext(get("next"));
}
export function removeTracker(library: LibraryStorage, id: string, next: string): string {
  if (!idPattern.test(id)) missingEntity("wish");
  library.db.deleteWish(id);
  return safeTrackerNext(next);
}
export function trackerCsv(library: LibraryStorage, search: Record<string, string>): string {
  const cell = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const rows = [["title", "author", "rating", "comment", "date"], ...trackerPayload(library, search).items.map(w => [w.title, w.author || "", w.rating === null ? "" : String(w.rating), w.comment || "", w.updated_at || ""])];
  return "\ufeff" + rows.map(row => row.map(cell).join(",") + "\r\n").join("");
}
