import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { metadataFromDict, type Metadata } from "../src/core/models";
import { buildEpub, extractEpubMetadata } from "../src/core/epub";
import { parseBook } from "../src/core/parsing";
import { readArchive } from "../src/core/archive";
import { BinderyDatabase } from "../src/server/db";
import { LibraryStorage, bookDir, epubPath, saveBook } from "../src/server/storage";
import { signIn } from "../src/server/auth";
import { authenticatedRoute, coverCacheHeaders, edgeRevalidateHeaders, httpError, HttpError, requireBook, redirectWithToast, setToastHeader } from "../src/server/http";
import { bookView, effectiveThemeId, statusView } from "../src/server/book-view";
import { bookCoverResponse, bookDownloadResponse, downloadFilename, fileResponse } from "../src/server/files";
import { bookEpubNeedsCssSync, composeBookCss, ensureBookEpubCss } from "../src/server/epub-css";
import { enqueueJob, queueCapacity } from "../src/server/jobs";
import { templateDirectory } from "../src/server/templates";

const root = mkdtempSync(join(tmpdir(), "bindery-foundation-"));
let library: LibraryStorage, id: string;
let sequence = 0;
beforeEach(() => {
  const dir = join(root, String(sequence++));
  library = new LibraryStorage(join(dir, "library"), new BinderyDatabase(join(dir, "db.sqlite")));
  library.ensure();
  id = "a".repeat(32);
  vi.stubEnv("BINDERY_TEMPLATE_DIR", join(dir, "templates"));
  vi.stubEnv("BINDERY_RULES_DIR", "");
  vi.stubEnv("BINDERY_THEMES_DIR", "");
  vi.stubEnv("BINDERY_INGEST_QUEUE_MAXSIZE", "");
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => rmSync(root, { recursive: true, force: true }));
function fixture(extra: Partial<Metadata> = {}, css = "") {
  const meta = metadataFromDict({ book_id: id, title: "乱世书", author: "姬叉", ...extra });
  library.saveMetadata(meta);
  const book = parseBook("第一章 开篇\n旧正文", "test");
  saveBook(book, library.base, id);
  writeFileSync(epubPath(library.base, id), buildEpub(book, meta, { css_text: css }));
  return meta;
}
const request = (path = "/", headers: HeadersInit = {}, method = "GET") => new Request("http://localhost" + path, { method, headers });

describe("authenticated server boundaries", () => {
  it("checks sessions even when a file handler is called outside the entry", async () => {
    const handler = vi.fn((_context: { library: LibraryStorage }) => Response.json({ ok: true }));
    const route = authenticatedRoute(handler, () => library);
    const anonymous = await route({ request: request("/book/test/cover"), params: {} });
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).toBe("/login?next=/book/test/cover");
    expect(handler).not.toHaveBeenCalled();
    const htmx = await route({ request: request("/jobs", { "HX-Request": "true" }), params: {} });
    expect(htmx.status).toBe(401);
    expect(htmx.headers.get("HX-Redirect")).toBe("/login?next=/jobs");
    const cookie = `bindery_session=${signIn(library.db)}`;
    const response = await route({ request: request("/", { Cookie: cookie }), params: {} });
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(handler.mock.calls[0][0].library).toBe(library);
  });
  it("maps expected errors and preserves explicit caching", async () => {
    const cookie = `bindery_session=${signIn(library.db)}`;
    const route = authenticatedRoute(() => { throw new HttpError(404, "书籍不存在"); }, () => library);
    const response = await route({ request: request("/", { Cookie: cookie }), params: {} });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: "书籍不存在" });
    const cached = authenticatedRoute(() => new Response("cover", { headers: coverCacheHeaders() }), () => library);
    expect((await cached({ request: request("/", { Cookie: cookie }), params: {} })).headers.get("cache-control")).toBe("private, max-age=604800, immutable");
    expect(httpError(Object.assign(new Error(), { code: "ENOENT" })).status).toBe(404);
    expect(httpError(Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR" })).status).toBe(503);
    expect(httpError(Object.assign(new Error("UNIQUE constraint failed"), { code: "ERR_SQLITE_ERROR" })).status).toBe(409);
    expect(httpError(new Error("/private/password")).detail).toBe("服务器内部错误");
    expect(httpError(Object.assign(new Error("Book exists"), { status: 409 })).detail).toBe("书籍已存在");
    expect(httpError(Object.assign(new Error("Book not found"), { status: 404 })).detail).toBe("书籍不存在");
  });
  it("provides redirect flashes and legacy-compatible HTMX notification headers", () => {
    const response = redirectWithToast("/jobs?tab=running", "已创建任务", "warning");
    expect(response.status).toBe(303);
    const url = new URL(response.headers.get("location")!, "http://localhost");
    expect(url.searchParams.get("tab")).toBe("running"); expect(url.searchParams.get("toast")).toBe("已创建任务");
    setToastHeader(response, "保存成功");
    expect(JSON.parse(response.headers.get("HX-Trigger")!)).toEqual({ "bindery:toast": { message: "保存成功", kind: "success" } });
  });
  it.each(["../escape", "a", "A".repeat(32), "f".repeat(32)])("rejects invalid/missing book %s", value => {
    expect(() => requireBook(value, library)).toThrow("书籍不存在");
  });
  it("rejects archived books and missing body files", () => {
    const meta = fixture();
    library.archiveBook(id);
    expect(() => requireBook(id, library)).toThrow("书籍不存在");
    meta.book_id = "b".repeat(32); meta.archived = false;
    library.saveMetadata(meta);
    expect(() => requireBook(meta.book_id, library)).toThrow("书籍不存在");
  });
});

describe("book view models", () => {
  it.each([
    [{ status: "failed" }, "转换失败", "failed"],
    [{ status: "dirty", epub_updated_at: "3", updated_at: "2" }, "待写回", "pending"],
    [{ epub_updated_at: "2", updated_at: "2" }, "已写回元数据", "ok"],
    [{ epub_updated_at: "1", updated_at: "2" }, "待写回", "pending"],
    [{}, "待写回", "pending"],
  ] as const)("matches legacy status rules: %j", (input, label, tone) => {
    expect(statusView(metadataFromDict(input))).toEqual({ status_label: label, status_class: tone });
  });
  it("uses nanosecond cover versions, copies tags and detects regeneration", () => {
    const meta = fixture({ cover_file: "cover.png", tags: ["小说"], updated_at: "date" });
    const path = join(bookDir(library.base, id), "cover.png");
    writeFileSync(path, "image");
    writeFileSync(join(bookDir(library.base, id), "source.txt"), "正文");
    const view = bookView(meta, library);
    expect(view.cover_url).toBe(`/book/${id}/cover?v=${statSync(path, { bigint: true }).mtimeNs}`);
    expect(view.can_regenerate).toBe(true);
    expect(view.path).toBe(bookDir(library.base, id));
    view.tags.push("新标签"); expect(meta.tags).toEqual(["小说"]);
    expect(bookView({ ...meta, cover_file: "absent.jpg" }, library).cover_url).toBe(`/book/${id}/cover?v=date`);
    expect(bookView({ ...meta, source_type: "epub" }, library).can_regenerate).toBe(false);
    expect(bookView({ ...meta, archived: true }, library).cover_url).toBeNull();
  });
  it("tracker overrides cached read/rating only for active books", () => {
    const meta = fixture({ read: true, rating: 5 });
    library.seedWishlistFromBooks();
    const wish = library.db.getWishByLibraryBookId(id)!;
    library.db.updateWish(wish.id, { read_status: "reading", rating: null });
    expect(bookView(meta, library)).toMatchObject({ read: false, rating: null });
    expect(bookView({ ...meta, archived: true }, library)).toMatchObject({ read: true, rating: 5 });
    expect(bookView(meta, library, { ...wish, read_status: "read", rating: 3 })).toMatchObject({ read: true, rating: 3 });
  });
  it("resolves theme sentinel and template directory environment precedence", () => {
    expect(effectiveThemeId(metadataFromDict({ source_type: "epub", theme_template: " __book__ " }))).toBeNull();
    expect(effectiveThemeId(metadataFromDict({ theme_template: " " }))).toBe("default");
    expect(templateDirectory("rules")).toBe(join(process.env.BINDERY_TEMPLATE_DIR!, "rules"));
    vi.stubEnv("BINDERY_THEMES_DIR", join(root, "override"));
    expect(templateDirectory("themes")).toBe(join(root, "override"));
  });
});

describe("shared cover and EPUB downloads", () => {
  it("ports legacy cover/private edge headers and revalidation headers", async () => {
    const meta = fixture({ cover_file: "cover.png" });
    const bytes = Buffer.from("89504e470d0a1a0a", "hex");
    writeFileSync(join(bookDir(library.base, id), meta.cover_file!), bytes);
    const response = bookCoverResponse(request(), id, library);
    expect(response.status).toBe(200);
    for (const [key, value] of Object.entries(coverCacheHeaders())) expect(response.headers.get(key)).toBe(value);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect(response.headers.get("last-modified")).toBeTruthy();
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    const cached = bookCoverResponse(request("/", { "If-None-Match": `W/${response.headers.get("etag")}` }), id, library);
    expect(cached.status).toBe(304); expect(await cached.text()).toBe("");
    expect(cached.headers.get("cache-control")).toBe(coverCacheHeaders()["Cache-Control"]);
    expect(edgeRevalidateHeaders()).toEqual({ "Cache-Control": "private, no-cache, must-revalidate", "CDN-Cache-Control": "no-store", "Cloudflare-CDN-Cache-Control": "no-store", Pragma: "no-cache" });
  });
  it("returns Chinese 404s for missing covers and EPUBs", () => {
    fixture();
    expect(() => bookCoverResponse(request(), id, library)).toThrow("封面不存在");
    const meta = library.loadMetadata(id); meta.cover_file = "missing.jpg"; library.saveMetadata(meta);
    expect(() => bookCoverResponse(request(), id, library)).toThrow("封面不存在");
    rmSync(epubPath(library.base, id));
    expect(() => bookDownloadResponse(request(), id, library)).toThrow("EPUB 不存在");
  });
  it.each([["cover.avif", "image/avif"], ["cover.bmp", "image/bmp"], ["cover.tiff", "image/tiff"]])("preserves cover MIME type for %s", async (filename, type) => {
    fixture({ cover_file: filename });
    writeFileSync(join(bookDir(library.base, id), filename), "image-bytes");
    const response = bookCoverResponse(request(), id, library);
    expect(response.headers.get("content-type")).toBe(type);
    await response.arrayBuffer();
  });
  it.each([
    ["乱世书", "姬叉", "乱世书-姬叉.epub"], ["乱世书", null, "乱世书-未知.epub"],
    ["  ", "  ", "book-未知.epub"], ["a/b : c", "x\r\ny", "a_b_c-x_y.epub"],
    ["🍃", "♥", "book-book.epub"], ["\u001c乱世书\u001f", "姬叉", "乱世书-姬叉.epub"],
  ])("ports legacy filename %j / %j", (title, author, expected) => {
    expect(downloadFilename({ title: title!, author })).toBe(expected);
  });
  it("sets RFC 5987 UTF-8 attachment and streams EPUB only", async () => {
    fixture({ source_type: "epub", theme_template: "__book__" });
    const bytes = readFileSync(epubPath(library.base, id));
    const response = bookDownloadResponse(request(), id, library);
    expect(response.headers.get("content-type")).toBe("application/epub+zip");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename*=utf-8''${encodeURIComponent("乱世书-姬叉.epub")}`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });
  it("supports HEAD, byte/suffix ranges, validators and unsatisfiable ranges", async () => {
    const path = join(root, "range.txt"); writeFileSync(path, "0123456789");
    const head = fileResponse(request("/", {}, "HEAD"), path);
    expect(head.headers.get("content-length")).toBe("10"); expect(await head.text()).toBe("");
    const partial = fileResponse(request("/", { Range: "bytes=2-5" }), path);
    expect(partial.status).toBe(206); expect(partial.headers.get("content-range")).toBe("bytes 2-5/10"); expect(await partial.text()).toBe("2345");
    expect(await fileResponse(request("/", { Range: "bytes=-3" }), path).text()).toBe("789");
    expect(fileResponse(request("/", { Range: "bytes=99-" }), path).status).toBe(416);
    const full = fileResponse(request("/", { Range: "bytes=2-3", "If-Range": "stale" }), path);
    expect(full.status).toBe(200); expect(await full.text()).toBe("0123456789");
    expect(fileResponse(request("/", { "If-Modified-Since": head.headers.get("last-modified")! }), path).status).toBe(304);
  });
});

describe("lazy EPUB CSS synchronization", () => {
  it.each(["txt-source", "txt-no-source", "epub-overlay", "epub-keep"])("matches real legacy view/download/CSS behavior: %s", async mode => {
    const imported = mode.startsWith("epub");
    const meta = fixture({ source_type: imported ? "epub" : "txt", theme_template: imported ? "__book__" : null, custom_css: mode === "epub-keep" ? null : "p { color: red; }", cover_file: "cover.png", tags: ["小说"] });
    writeFileSync(join(bookDir(library.base, id), "cover.png"), readFileSync("tests-ts/fixtures/cover 中文.png"));
    if (mode === "txt-source") writeFileSync(join(bookDir(library.base, id), "source.txt"), "第一章 新章\n新正文");
    const original = readFileSync(epubPath(library.base, id));
    const { read_updated_at: _unused, ...view } = bookView(meta, library);
    const reference = JSON.parse(readFileSync(resolve("tests-ts/fixtures/parity/foundation", `${mode}.json`), "utf8"));
    const normalizeView = (value: typeof view) => ({ ...value, path: "<library>/<id>", cover_url: value.cover_url?.replace(/\?v=\d+$/, "?v=<mtime>") });
    expect(normalizeView(view)).toEqual(reference.view);
    expect(downloadFilename(meta)).toBe(reference.filename);
    expect(coverCacheHeaders()).toEqual(reference.headers);
    writeFileSync(epubPath(library.base, id), original); library.saveMetadata(meta);
    expect(bookEpubNeedsCssSync(original, meta)).toBe(reference.needs_before);
    ensureBookEpubCss(meta, library);
    expect(bookEpubNeedsCssSync(readFileSync(epubPath(library.base, id)), meta)).toBe(reference.needs_after);
    const members = readArchive(readFileSync(epubPath(library.base, id))).map(entry => ({ name: entry.name, data: Buffer.from(entry.name.endsWith(".opf") ? new TextEncoder().encode(new TextDecoder().decode(entry.data).replace(/(<(?:\w+:)?meta property="dcterms:modified">)[^<]+/g, "$1TIMESTAMP")) : entry.data).toString("base64") }));
    expect(members).toEqual(reference.members);
  });
  it.each([true, false])("ports TXT CSS synchronization when source exists = %j", hasSource => {
    const meta = fixture({ custom_css: "p { color: red; }", status: "dirty" });
    if (hasSource) writeFileSync(join(bookDir(library.base, id), "source.txt"), "第一章 新章\n新正文");
    expect(bookEpubNeedsCssSync(readFileSync(epubPath(library.base, id)), meta)).toBe(true);
    ensureBookEpubCss(meta, library);
    const bytes = readFileSync(epubPath(library.base, id));
    // the legacy implementation's source-less fallback adds an overlay but still compares style.css.
    expect(bookEpubNeedsCssSync(bytes, meta)).toBe(!hasSource);
    expect(library.loadMetadata(id)).toMatchObject({ status: "synced", epub_updated_at: meta.updated_at });
    expect(meta.updated_at).not.toBe("");
    if (hasSource) expect(readFileSync(join(bookDir(library.base, id), "book.json"), "utf8")).toContain("新正文");
    if (hasSource) {
      ensureBookEpubCss(meta, library);
      expect(readFileSync(epubPath(library.base, id))).toEqual(bytes);
    }
  });
  it("adds/replaces/removes imported EPUB overlays without rebuilding its documents or cover", () => {
    const meta = fixture({ source_type: "epub", theme_template: "__book__", custom_css: "p { color: red; }" });
    const original = readArchive(readFileSync(epubPath(library.base, id))).find(e => e.name.endsWith("section_0001.xhtml"));
    ensureBookEpubCss(meta, library);
    let entries = readArchive(readFileSync(epubPath(library.base, id)));
    expect(entries.some(e => e.name.endsWith("/bindery.css"))).toBe(true);
    expect(extractEpubMetadata(readFileSync(epubPath(library.base, id)), "fallback").title).toBe(meta.title);
    expect(original).toBeTruthy();
    const document = entries.find(e => e.name === original!.name)!;
    expect(new TextDecoder().decode(document.data)).toContain("旧正文");
    meta.custom_css = "p { color: blue; }";
    ensureBookEpubCss(meta, library);
    expect(bookEpubNeedsCssSync(readFileSync(epubPath(library.base, id)), meta)).toBe(false);
    meta.custom_css = "";
    ensureBookEpubCss(meta, library);
    entries = readArchive(readFileSync(epubPath(library.base, id)));
    expect(entries.some(e => e.name.endsWith("/bindery.css"))).toBe(false);
    expect(composeBookCss(meta)).toBe("");
  });
  it("does not damage the EPUB on parse failure or create a missing EPUB", () => {
    const meta = fixture();
    writeFileSync(epubPath(library.base, id), "broken");
    expect(() => ensureBookEpubCss(meta, library)).toThrow();
    expect(readFileSync(epubPath(library.base, id), "utf8")).toBe("broken");
    rmSync(epubPath(library.base, id)); ensureBookEpubCss(meta, library);
    expect(existsSync(epubPath(library.base, id))).toBe(false);
  });
});

describe("durable job submission", () => {
  it("inserts legacy-compatible jobs without running a worker and survives another storage instance", () => {
    const result = enqueueJob({ book_id: id, rule_template: "default" }, library);
    expect(result.queued).toBe(true);
    expect(result.job).toMatchObject({ book_id: id, action: "regenerate", status: "running", stage: "排队中", message: "等待后台处理", log: null, rule_template: "default" });
    expect(result.job.id).toMatch(/^[a-f0-9]{32}$/);
    expect(new BinderyDatabase(library.db.path).getJob(result.job.id)).toEqual(result.job);
    expect(result.job.updated_at).toBe(result.job.created_at);
  });
  it("counts only waiting jobs and retains a failed row when the queue is full", () => {
    vi.stubEnv("BINDERY_INGEST_QUEUE_MAXSIZE", "1");
    const first = enqueueJob({ book_id: id }, library);
    const failed = enqueueJob({ book_id: id, action: "retry" }, library);
    expect(failed.queued).toBe(false);
    expect(library.db.getJob(failed.job.id)).toMatchObject({ status: "failed", stage: "失败", message: "任务队列已满，请稍后重试", log: null });
    library.db.updateJob(first.job.id, { stage: "解析中" });
    expect(enqueueJob({ book_id: null, action: "upload" }, library).queued).toBe(true);
  });
  it.each([["", 64], ["invalid", 64], ["1.5", 64], ["0", 1], ["-1", 1], ["9999", 2048]])("normalizes queue capacity %j", (value, expected) => {
    vi.stubEnv("BINDERY_INGEST_QUEUE_MAXSIZE", value); expect(queueCapacity()).toBe(expected);
  });
  it("rejects invalid parameters before inserting", () => {
    expect(() => enqueueJob({ book_id: "../bad" }, library)).toThrow("任务参数错误");
    expect(() => enqueueJob({ book_id: null }, library)).toThrow("任务参数错误");
    expect(library.db.listJobs()).toEqual([]);
  });
  it("publishes a pre-staged upload ID and rolls back a duplicate insert", () => {
    const result = enqueueJob({ id, book_id: null, action: "upload-epub" }, library);
    expect(result.job.id).toBe(id);
    expect(() => enqueueJob({ id, book_id: null, action: "upload-epub" }, library)).toThrow();
    expect(library.db.listJobs()).toHaveLength(1);
    expect(() => enqueueJob({ id: "../bad", book_id: null, action: "upload" }, library)).toThrow("任务参数错误");
  });
});
