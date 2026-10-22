import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { libraryPage, loadLibraryPage } from "../src/server/library/queries";
import { archiveBooks, deleteArchivedBooks, downloadBooks, normalizeBookIds, regenerateBooks, restoreArchivedBooks } from "../src/server/library/actions";
import { archivePost, deletePost, downloadPost } from "../src/server/library/handlers";
import { bookHref, devicePreviewHref, deviceTransferHref, gridPageSize, gridPageSizeFromCookie, libraryQueryInput, libraryReturnTo, normalizeSearch, transferSelection } from "../src/features/library/search";
import { metadataFromDict } from "../src/core/models";
import { readArchive } from "../src/core/archive";
import { bookEpubNeedsCssSync } from "../src/server/epub-css";
import { authenticatedRoute, HttpError } from "../src/server/http";
import { signIn } from "../src/server/auth";
import { epubPath } from "../src/server/storage";
import { createBook, temporaryLibrary } from "./fixtures/library/support";

let fixture: ReturnType<typeof temporaryLibrary>;
const a = "a".repeat(32), b = "b".repeat(32), c = "c".repeat(32);
beforeEach(() => {
  fixture = temporaryLibrary();
  vi.stubEnv("BINDERY_TEMPLATE_DIR", join(fixture.root, "templates"));
  vi.stubEnv("BINDERY_RULES_DIR", ""); vi.stubEnv("BINDERY_THEMES_DIR", "");
  vi.stubEnv("BINDERY_INGEST_QUEUE_MAXSIZE", "64");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(fixture.root, { recursive: true, force: true }); });

describe("library filters, sorting and pagination (legacy library_filters)", () => {
  it("uses 24 books by default, accepts custom page sizes and clamps to the final page", () => {
    const { library } = fixture;
    for (let index = 0; index < 25; index++) library.saveMetadata(metadataFromDict({ book_id: index.toString(16).padStart(32, "0"), title: `书-${index}`, updated_at: `2026-02-06T00:00:${String(index).padStart(2, "0")}+00:00` }));
    const one = libraryPage(library), two = libraryPage(library, { page: 2 });
    expect(one).toMatchObject({ total_books: 25, total_pages: 2, per_page: 24, has_prev: false, has_next: true });
    expect(one.books).toHaveLength(24); expect(two.books).toHaveLength(1);
    expect(libraryPage(library, { per_page: 20 }).books).toHaveLength(20);
    expect(libraryPage(library, { per_page: 20, page: 99 })).toMatchObject({ page: 2, total_pages: 2, has_next: false });
  });
  it("uses the paged storage query without scanning all books", () => {
    const { library } = fixture;
    const meta = metadataFromDict({ book_id: a, title: "分页样例" });
    vi.spyOn(library, "listBooks").mockImplementation(() => { throw new Error("legacy scan"); });
    const query = vi.spyOn(library, "listBooksPage").mockReturnValue([[meta], 1]);
    expect(libraryPage(library).books[0]!.title).toBe("分页样例"); expect(query).toHaveBeenCalledExactlyOnceWith(normalizeSearch({}));
  });
  it("filters unread using linked tracker state and falls back to all for unknown filters", () => {
    const { library } = fixture;
    createBook(library, a, { read: false }); createBook(library, b, { read: true });
    expect(libraryPage(library, { read_filter: "unread" }).books.map(book => book.book_id)).toEqual([a]);
    const wish = library.db.getWishByLibraryBookId(a)!;
    library.db.updateWish(wish.id, { read_status: "read", read: true, rating: 4 });
    expect(libraryPage(library, { read_filter: "unread" }).total_books).toBe(0);
    const all = libraryPage(library, normalizeSearch({ read_filter: "unexpected" }));
    expect(all).toMatchObject({ total_books: 2, read_filter: "all" });
    expect(all.books.find(book => book.book_id === a)).toMatchObject({ read: true, rating: 4 });
  });
  it("searches title/author, supports both sort orders and excludes archive rows", () => {
    const { library } = fixture;
    createBook(library, a, { title: "Alpha", author: "甲", created_at: "2026-02", updated_at: "2026-03" });
    createBook(library, b, { title: "乙", author: "ALPHA", created_at: "2026-03", updated_at: "2026-02" });
    createBook(library, c); archiveBooks([c], library);
    expect(libraryPage(library, { q: " alpha " }).books.map(book => book.book_id)).toEqual([a, b]);
    expect(libraryPage(library, { sort: "created" }).books.map(book => book.book_id)).toEqual([b, a]);
    expect(libraryPage(library, { q: "missing", page: 9 })).toMatchObject({ page: 1, total_books: 0, total_pages: 1, books: [] });
    expect(libraryPage(library, { scope: "archived" }).books.map(book => book.book_id)).toEqual([c]);
  });
  it("searches, sorts and paginates archived directories before slicing, ignoring read_filter", () => {
    const { library } = fixture;
    for (let index = 0; index < 7; index++) {
      const id = String(index).repeat(32);
      createBook(library, id, { title: index % 2 ? "Alpha" : "乙", author: index % 2 ? "作者" : "ALPHA", read: true, created_at: String(index), updated_at: String(7 - index) });
      archiveBooks([id], library);
      library.saveMetadata({ ...library.loadMetadata(id), updated_at: String(7 - index) });
    }
    createBook(library, a, { title: "Alpha" });
    rmSync(join(library.base, "archive", "0".repeat(32)), { recursive: true });
    const options = { scope: "archived", q: " alpha ", per_page: 2, read_filter: "unread" };
    const [updated, total] = library.listBooksPage(options);
    expect(total).toBe(6); expect(updated.map(book => book.book_id)).toEqual(["1".repeat(32), "2".repeat(32)]);
    expect(library.listBooksPage({ ...options, page: 2 })[0].map(book => book.book_id)).toEqual(["3".repeat(32), "4".repeat(32)]);
    expect(library.listBooksPage({ ...options, sort: "created" })[0].map(book => book.book_id)).toEqual(["6".repeat(32), "5".repeat(32)]);
    expect(library.listBooksPage({ ...options, q: "missing" })).toEqual([[], 0]);
    expect(libraryPage(library, { scope: "archived", per_page: 4, page: 99, read_filter: "unread" })).toMatchObject({ page: 2, total_books: 6, total_pages: 2, read_filter: "all", scope: "archived" });
  });
  it("does not create tracker entries or mutate archived metadata when viewing the archive", () => {
    const { library } = fixture;
    createBook(library, a, { read: false, rating: 2 }); createBook(library, b);
    library.seedWishlistFromBooks();
    const wish = library.db.getWishByLibraryBookId(a)!; library.db.updateWish(wish.id, { read: true, read_status: "read", rating: 5 });
    archiveBooks([a, b], library);
    library.db.deleteWish(library.db.getWishByLibraryBookId(b)!.id);
    const metadata = library.loadMetadata(a), wishes = library.db.listWishes();
    expect(libraryPage(library, { scope: "archived" }).books.find(book => book.book_id === a)).toMatchObject({ read: false, rating: 2 });
    expect(library.loadMetadata(a)).toEqual(metadata); expect(library.db.listWishes()).toEqual(wishes);
  });
  it("preserves storage orphan totals and does not replace missing directories with full scans", () => {
    const { library } = fixture; createBook(library, a); rmSync(join(library.base, a), { recursive: true });
    expect(libraryPage(library)).toMatchObject({ total_books: 1, books: [] });
  });
});

describe("return navigation and responsive sizing", () => {
  it("writes only non-default parameters into return URLs, including whitespace and encoded Chinese", () => {
    expect(libraryReturnTo({ sort: "unexpected", q: "abc", page: 0, read_filter: "unexpected" })).toBe("/?q=abc");
    expect(libraryReturnTo({ scope: "active", sort: "updated", q: "", page: 1, read_filter: "all", per_page: 28 })).toBe("/");
    const back = libraryReturnTo({ sort: " CREATED ", q: "长安 & 作者", page: 2, read_filter: " UNREAD ", per_page: 20 });
    expect(back).toBe("/?q=%E9%95%BF%E5%AE%89+%26+%E4%BD%9C%E8%80%85&sort=created&read_filter=unread&page=2");
    const href = bookHref(a, back, true);
    expect(new URL(href, "http://local").searchParams.get("return_to")).toBe(back);
    expect(href).toContain(`/book/${a}/preview/0?resume=1&return_to=`);
  });
  it("normalizes scope and preserves archived return URLs without unread filtering", () => {
    expect(normalizeSearch({ scope: " ARCHIVED ", read_filter: "unread" })).toMatchObject({ scope: "archived", read_filter: "all" });
    expect(normalizeSearch({ scope: "bogus" }).scope).toBe("active");
    const archived = new URL(libraryReturnTo({ scope: "archived", q: "书", page: 3, read_filter: "unread" }), "http://local");
    expect(Object.fromEntries(archived.searchParams)).toEqual({ scope: "archived", q: "书", page: "3" });
    expect(libraryReturnTo({ scope: "active" })).not.toContain("scope=");
  });
  it.each([[0, 4], [136, 4], [292, 8], [916, 24], [99999, 96]])("uses four rows at width %i", (width, size) => expect(gridPageSize(width)).toBe(size));
  it.each([[0, 4], [200, 96], ["garbage", 24]])("normalizes page size %s", (value, expected) => expect(normalizeSearch({ per_page: value }).per_page).toBe(expected));
  it("hands selected books to the device transfer page and drops anything that is not a book id", () => {
    const a = "a".repeat(32), b = "b".repeat(32);
    expect(deviceTransferHref([a, b])).toBe(`/devices/transfer?books=${a},${b}`);
    expect(transferSelection(`${a},${b},${a},../x,${"A".repeat(32)}`)).toEqual([a, b]);
    expect(transferSelection(undefined)).toEqual([]);
    expect(devicePreviewHref(a)).toBe(`/devices/preview?book=${a}`);
  });
  it("reads the remembered grid size only when the URL has no page size", () => {
    expect(gridPageSizeFromCookie("theme=dark; bindery_grid_per_page=28; x=1")).toBe(28);
    for (const header of [null, "", "bindery_grid_per_page=2", "bindery_grid_per_page=200", "bindery_grid_per_page=abc", "xbindery_grid_per_page=28"]) expect(gridPageSizeFromCookie(header)).toBeNull();
    expect(libraryQueryInput({}).perPageGiven).toBe(false); expect(libraryQueryInput({ per_page: "24" }).perPageGiven).toBe(true);
  });
  it("rejects malformed public pagination with 422 while preserving normalizable integer inputs", () => {
    expect(() => loadLibraryPage(fixture.library, libraryQueryInput({ page: "oops" }))).toThrow(new HttpError(422, "分页参数必须为整数"));
    expect(() => loadLibraryPage(fixture.library, libraryQueryInput({ per_page: 1.5 }))).toThrow(new HttpError(422, "分页参数必须为整数"));
    expect(loadLibraryPage(fixture.library, libraryQueryInput({ per_page: "4.0", page: -2 }))).toMatchObject({ per_page: 4, page: 1 });
  });
});

describe("bulk file/data operations (legacy bulk_actions)", () => {
  it("deduplicates valid IDs, ignores malformed/nonexistent books, preserves bytes when archiving", () => {
    const { library } = fixture; createBook(library, a); createBook(library, b);
    const bytes = readFileSync(epubPath(library.base, a));
    expect(normalizeBookIds([` ${a} `, a, "bad-id", "A".repeat(32)])).toEqual([a]);
    expect(archiveBooks([a, "bad-id", b, a, c], library)).toBe(2);
    expect(library.listBooks()).toHaveLength(0); expect(library.listArchivedBooks().map(book => book.book_id).sort()).toEqual([a, b]);
    expect(readFileSync(join(library.base, "archive", a, "book.epub"))).toEqual(bytes);
    expect(library.loadMetadata(a).archived).toBe(true);
  });
  it("deletes only archived selections and preserves active files and unrelated DB rows", () => {
    const { library } = fixture; for (const id of [a, b, c]) createBook(library, id);
    library.seedWishlistFromBooks();
    const linkedWish = library.db.getWishByLibraryBookId(a);
    archiveBooks([a, b], library); expect(deleteArchivedBooks([a, c, "bad-id", a], library)).toBe(1);
    expect(library.listBooks().map(book => book.book_id)).toEqual([c]); expect(library.listArchivedBooks().map(book => book.book_id)).toEqual([b]);
    expect(library.db.get("SELECT * FROM books WHERE book_id = ?", a)).toBeNull();
    expect(library.db.getWishByLibraryBookId(a)).toEqual(linkedWish);
    expect(existsSync(epubPath(library.base, c))).toBe(true);
  });
  it("restores in bulk through storage and validates destination conflicts before moving", () => {
    const { library } = fixture; createBook(library, a); createBook(library, b); archiveBooks([a, b], library);
    mkdirSync(join(library.base, b));
    expect(() => restoreArchivedBooks([a, b], library)).toThrow("书籍已存在");
    expect(existsSync(join(library.base, "archive", a))).toBe(true);
    rmSync(join(library.base, b), { recursive: true });
    expect(restoreArchivedBooks([a, b, c, a, "bad-id"], library)).toBe(2);
    expect(library.loadMetadata(a).archived).toBe(false); expect(library.listArchivedBooks()).toHaveLength(0);
  });
  it("downloads unique sanitized names and keeps unknown-title/author fallbacks", async () => {
    const { library } = fixture;
    createBook(library, a, { title: "Same", author: "Author", theme_template: "__book__", source_type: "epub" });
    createBook(library, b, { title: "Same", author: "Author", theme_template: "__book__", source_type: "epub" });
    createBook(library, c, { title: "", author: "", theme_template: "__book__", source_type: "epub" });
    const response = downloadBooks([a, b, a, "bad-id", c], library, new Date(2026, 9, 19, 8, 9, 10));
    expect(response.headers.get("Content-Type")).toBe("application/zip"); expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="bindery-books-20261019-080910.zip"');
    const entries = readArchive(new Uint8Array(await response.arrayBuffer()));
    expect(entries.map(entry => entry.name)).toEqual(["Same-Author.epub", "Same-Author-2.epub", "book-未知.epub"]);
    expect(entries[0]!.data).toEqual(new Uint8Array(readFileSync(epubPath(library.base, a))));
  });
  it("rejects empty selections with 400 and selections without EPUBs with 404", () => {
    const { library } = fixture; createBook(library, a); rmSync(epubPath(library.base, a));
    expect(() => downloadBooks([], library)).toThrow(new HttpError(400, "未选择书籍"));
    expect(() => downloadBooks([a, b], library)).toThrow(new HttpError(404, "未找到可下载的 EPUB"));
    archiveBooks([a], library); expect(() => downloadBooks([a], library)).toThrow("未找到可下载的 EPUB");
  });
  it("synchronizes EPUB CSS and metadata before packing rather than exporting stale bytes", async () => {
    const { library } = fixture; createBook(library, a, { custom_css: "p { color: red; }" }, true);
    const before = readFileSync(epubPath(library.base, a));
    const response = downloadBooks([a], library), packed = readArchive(new Uint8Array(await response.arrayBuffer()))[0]!.data;
    expect(packed).not.toEqual(new Uint8Array(before));
    expect(packed).toEqual(new Uint8Array(readFileSync(epubPath(library.base, a))));
    const meta = library.loadMetadata(a);
    expect(bookEpubNeedsCssSync(packed, meta)).toBe(false); expect(meta.epub_updated_at).toBe(meta.updated_at); expect(meta.status).toBe("synced");
  });
  it("queues only eligible selected TXT books and reports real queue failures", () => {
    const { library } = fixture;
    createBook(library, a, { rule_template: "webnovel" }, true); createBook(library, b, { source_type: "epub" }, true); createBook(library, c);
    expect(regenerateBooks([a, b, c, a, "bad-id"], library)).toEqual({ queued: 1, failed: 0, skipped: 2 });
    vi.stubEnv("BINDERY_INGEST_QUEUE_MAXSIZE", "1");
    expect(regenerateBooks([a], library)).toEqual({ queued: 0, failed: 1, skipped: 0 });
    expect(library.db.listJobs().map(job => [job.book_id, job.rule_template, job.action]).every(row => row.join() === [a, "webnovel", "regenerate"].join())).toBe(true);
    expect(library.db.listJobs().some(job => job.status === "failed")).toBe(true);
  });
});

describe("authenticated HTTP form handlers and redirects", () => {
  async function post(handler: typeof archivePost, ids: string[], authenticated = true) {
    const form = new FormData(); for (const id of ids) form.append("book_ids", id);
    form.set("next", "https://evil.invalid/");
    const request = new Request("http://local/books/archive", { method: "POST", body: form, headers: authenticated ? { Cookie: `bindery_session=${signIn(fixture.library.db)}` } : {} });
    return authenticatedRoute(handler, () => fixture.library)({ request, params: {} });
  }
  it("rejects anonymous actions before touching files", async () => {
    createBook(fixture.library, a); expect((await post(archivePost, [a], false)).status).toBe(303);
    expect(fixture.library.loadMetadata(a).archived).toBe(false);
  });
  it("keeps bulk redirect targets within the merged library and no-store responses", async () => {
    createBook(fixture.library, a);
    const archived = await post(archivePost, [a, "bad-id"]);
    expect(archived.status).toBe(303); expect(archived.headers.get("Location")).toBe("/"); expect(archived.headers.get("Cache-Control")).toBe("no-store");
    const deleted = await post(deletePost, [a]); expect(deleted.status).toBe(303); expect(deleted.headers.get("Location")).toBe("/?scope=archived");
  });
  it("returns JSON business errors for downloads", async () => {
    const empty = await post(downloadPost, []); expect(empty.status).toBe(400); expect(await empty.json()).toEqual({ detail: "未选择书籍" });
    const missing = await post(downloadPost, [a]); expect(missing.status).toBe(404); expect(await missing.json()).toEqual({ detail: "未找到可下载的 EPUB" });
  });
});
