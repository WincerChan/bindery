import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { readArchive } from "../src/core/archive";
import { metadataFromDict } from "../src/core/models";
import { archiveBooks, downloadBooks, restoreArchivedBooks } from "../src/server/library/actions";
import { deletePost } from "../src/server/library/handlers";
import { libraryPage } from "../src/server/library/queries";
import { normalizeSearch } from "../src/features/library/search";
import { createBook, temporaryLibrary } from "./fixtures/library/support";

let fixture: ReturnType<typeof temporaryLibrary>;
const a = "a".repeat(32), b = "b".repeat(32), c = "c".repeat(32);
beforeEach(() => {
  fixture = temporaryLibrary();
  vi.stubEnv("BINDERY_TEMPLATE_DIR", join(fixture.root, "templates")); vi.stubEnv("BINDERY_RULES_DIR", ""); vi.stubEnv("BINDERY_THEMES_DIR", "");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(fixture.root, { recursive: true, force: true }); });
const reference = (mode: "pages" | "bulk") => JSON.parse(readFileSync(resolve("tests-ts/fixtures/parity/library", `${mode}.json`), "utf8"));
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function members(bytes: Uint8Array) {
  return readArchive(bytes).map(entry => [entry.name, digest(entry.name.endsWith(".opf") ? Buffer.from(Buffer.from(entry.data).toString().replace(/(property="dcterms:modified"[^>]*>)[^<]*(<\/)/g, "$1MODIFIED$2")) : entry.data)]);
}
function snapshot() {
  const { library } = fixture, files: Record<string, unknown> = {};
  for (const prefix of ["", "archive/"]) for (const id of [a, b, c]) {
    const dir = join(library.base, prefix, id); if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name), bytes = readFileSync(path);
      files[relative(library.base, path)] = entry.name === "book.epub" ? members(bytes) : digest(bytes);
    }
  }
  return { metadata: [...library.listBooks(), ...library.listArchivedBooks()].sort((x, y) => x.book_id.localeCompare(y.book_id)), files };
}

describe("actual legacy library parity", () => {
  it("matches normalized filters, sorts, page sizes and out-of-range page payloads", async () => {
    const { library } = fixture;
    for (let index = 0; index < 25; index++) library.saveMetadata(metadataFromDict({ book_id: index.toString(16).padStart(32, "0"), title: `书-${index}`, author: index % 2 ? "ALPHA" : "乙", read: index % 3 === 0, created_at: String(25 - index).padStart(2, "0"), updated_at: String(index).padStart(2, "0") }));
    library.seedWishlistFromBooks();
    const queries = [normalizeSearch({}), normalizeSearch({ page: 2 }), normalizeSearch({ per_page: 20, page: 99 }), normalizeSearch({ sort: " CREATED ", q: "alpha", read_filter: " UNREAD " }), normalizeSearch({ q: "missing", page: 8 }), normalizeSearch({ sort: "unknown", per_page: 0, page: -2, read_filter: "unknown" })];
    const expected = reference("pages");
    const actual = queries.map(query => {
      const { scope: _scope, return_to: _return, sort: _sort, q: _q, ...page } = libraryPage(library, query);
      return { ...page, books: page.books.map(({ book_id, title, author, read, rating, status_label, status_class }) => ({ book_id, title, author, read, rating, status_label, status_class })) };
    });
    expect(actual).toEqual(expected);
  });
  it("matches ZIP contents, CSS/book.json rewrites, DB metadata and archive/delete/restore file effects", async () => {
    const { library } = fixture;
    createBook(library, a, { title: "相同", author: "作者", custom_css: "p { color: red; }" }, true);
    createBook(library, b, { title: "相同", author: "作者", source_type: "epub", custom_css: "p { color: blue; }" });
    createBook(library, c, { title: "第三本", author: null, custom_css: "p { color: green; }" });
    const expected = reference("bulk");
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-19T01:02:03Z"));
    const response = downloadBooks([a, b, c, a, "bad-id"], library);
    const actual: Record<string, unknown> = { empty: [400, "未选择书籍"], missing: [404, "未找到可下载的 EPUB"], bundle: readArchive(new Uint8Array(await response.arrayBuffer())).map(entry => [entry.name, members(entry.data)]), downloaded: snapshot() };
    archiveBooks([a, b, "bad-id", a], library); actual.archive_response = [303, "/"]; actual.archived = snapshot();
    const form = new FormData(); for (const id of [a, c, "bad-id"]) form.append("book_ids", id);
    const deleted = await deletePost({ request: new Request("http://local/archive/delete-bulk", { method: "POST", body: form }), library, params: {} });
    // 导航合并有意偏离 legacy 的 /archive；文件和数据副作用仍严格比对。
    expect([deleted.status, deleted.headers.get("Location")]).toEqual([303, "/?scope=archived"]);
    delete expected.delete_response; actual.deleted = snapshot();
    restoreArchivedBooks([b], library); actual.restored = snapshot();
    expect(actual).toEqual(expected);
  });
});
