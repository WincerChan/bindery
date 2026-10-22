import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateCss } from "../src/core/css";
import { readArchive, writeArchive } from "../src/core/archive";
import { buildEpub, extractCover } from "../src/core/epub";
import { bookFromDict, type Metadata, type Wish } from "../src/core/models";
import { BinderyDatabase } from "../src/server/db";
import { LibraryStorage, epubPath, saveCoverBytes, sourcePath } from "../src/server/storage";
import { ensureTrackerConsistencyForMeta } from "../src/server/tracker";
import { libraryPage } from "../src/server/library/queries";
import { loadBookPage, saveBookEdit } from "../src/server/books/service";
import { loadReader } from "../src/server/reader/service";
import { submitUploads } from "../src/server/ingest/actions";
import { stageUpload, loadStaged, queueDirectory } from "../src/server/ingest/staging";
import { drainJobs, recoverJobs } from "../src/server/ingest/queue";
import { enqueueEditWriteback, enqueueJob } from "../src/server/jobs";
import { loadEditWriteback } from "../src/server/ingest/edit-staging";
import { startJobWorker, stopJobWorker } from "../src/server/ingest/lifecycle";
import { temporaryLibrary, createBook } from "./fixtures/library/support";

let root: string, library: LibraryStorage;
const id = "a".repeat(32), now = "2026-10-19T12:00:00+00:00";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X4D1kAAAAASUVORK5CYII=", "base64");
const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const newPng = Buffer.concat([png, Buffer.from("new cover")]);
const options = () => ({ cover_bytes: null as Uint8Array | null, cover_name: null as string | null, cover_url: "", strip_original_css: false, strip_fonts: false });
const form = (values: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(values)) f.set(k, v); return f; };
const reference = (mode: string) => JSON.parse(readFileSync(resolve("tests-ts/fixtures/parity/integration", `${mode}.json`), "utf8"));
beforeEach(() => {
  ({ root, library } = temporaryLibrary());
  for (const name of ["BINDERY_RULES_DIR", "BINDERY_THEMES_DIR", "BINDERY_RULES_DIR_FILE", "BINDERY_THEMES_DIR_FILE"]) vi.stubEnv(name, "");
  vi.stubEnv("BINDERY_TEMPLATE_DIR", join(root, "templates")); vi.stubEnv("BINDERY_STAGE_DIR", join(root, "stage"));
});
afterEach(async () => { await stopJobWorker(library); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

const cssCases = ["", " \u0085\u001c", " ".repeat(200001), "😀".repeat(200000), "😀".repeat(200001), "a".repeat(200001) + "\0", "\0", "/*", 'a{"x', "}", "a{", 'a{content:"} /* \\"";} /* { } */', "/* } */ a { content: '{'; }", '"x\\', "}/*", 'a{"unterminated/*', "/* ' } */ { }", "a { color: red; }", "\ufeff".repeat(200001)];
describe("one legacy CSS validator", () => {
  it("matches every error branch, precedence, legacy whitespace and Unicode boundary", async () => {
    const expected = reference("css");
    expect(cssCases.map(validateCss)).toEqual(expected);
    expect(new Set(expected)).toEqual(new Set([null, "CSS 过长（超过 200000 字符）", "CSS 包含非法字符", "CSS 注释未闭合", "CSS 字符串未闭合", "CSS 花括号不匹配"]));
  });
  it("persists CSS using legacy whitespace semantics in both edit and ingest", async () => {
    createBook(library, id, { source_type: "epub", theme_template: "__book__" });
    for (const [css, expected] of [["\u0085\u001c", null], ["\ufeff", "\ufeff"]] as const) {
      await saveBookEdit(id, form({ custom_css: css }), library);
      expect(library.loadMetadata(id).custom_css).toBe(expected);
      const upload = form({ custom_css: css }); upload.set("files", new File(["第一章 开始\n正文"], "unicode.txt"));
      await submitUploads(library, upload); await drainJobs(library);
      const created = library.db.listJobs().find(j => j.action === "upload" && library.loadMetadata(j.book_id!).custom_css === expected);
      expect(created).toBeDefined();
    }
  });
  it.each(["\0", "/*", '"', "{", "}", "😀".repeat(200001)])("rejects upload CSS before deleting any staged files or publishing jobs (%#)", async css => {
    const a = await stageUpload(library, new File(["正文"], "a.txt")), b = await stageUpload(library, new File(["正文"], "b.txt"));
    const result = await submitUploads(library, form({ upload_tokens: a.token, custom_css: css }));
    expect(result).toEqual({ error: `自定义 CSS 校验失败：${validateCss(css)}`, custom_css: css });
    expect(library.db.listJobs()).toEqual([]); expect(loadStaged(library, a.token)).not.toBeNull(); expect(loadStaged(library, b.token)).not.toBeNull();
  });
});

function wish(extra: Partial<Wish> = {}): Wish {
  return { id: "f".repeat(32), library_book_id: null, title: "同名书", author: "作者", rating: 5, read: true, read_status: "read", tags: ["手动"], comment: "保留", book_status: "ongoing", created_at: "old", updated_at: "old", ...extra };
}
const normalizedWishes = (wishes: Wish[]) => wishes.map(({ id: _, ...w }) => w).sort((a, b) => (a.library_book_id || a.title).localeCompare(b.library_book_id || b.title));
describe("shared tracker consistency", () => {
  it.each(["library", "detail", "edit", "reader"])("matches legacy database effects through %s and is idempotent", async entry => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now));
    const meta = createBook(library, id, { source_type: "epub", theme_template: "__book__", custom_css: null, read: false, rating: 1 });
    library.db.createWish(wish({ library_book_id: "invalid legacy id" }));
    // Library listing only ensures visible books; an off-page fifth book stays unlinked.
    if (entry === "library") for (let n = 1; n <= 4; n++) createBook(library, n.toString().repeat(32), { created_at: `2025-01-0${n}T00:00:00+00:00` });
    const invoke = () => entry === "library" ? libraryPage(library, { per_page: 4, sort: "created" }) : entry === "reader" ? loadReader(id, "0", "/", library) : loadBookPage(id, "/", library);
    invoke(); const expected = reference(`tracker-${entry}`);
    expect(library.listBooks()).toEqual(expected.books);
    expect(normalizedWishes(library.db.listWishes())).toEqual(normalizedWishes(expected.wishes));
    const saved = library.loadMetadata(id); expect(saved).toMatchObject({ read: true, rating: 5, read_updated_at: now, updated_at: meta.updated_at, status: meta.status, epub_updated_at: meta.epub_updated_at });
    const before = library.db.listWishes(); invoke(); expect(library.db.listWishes()).toEqual(before); expect(library.loadMetadata(id)).toEqual(saved);
    if (entry === "library") expect(library.db.getWishByLibraryBookId("1".repeat(32))).toBeNull();
  });
  it("renames linked identities while preserving read/rating/notes, and only dates read changes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now));
    const meta = createBook(library, id, { title: "新标题", author: "新作者", read: true, rating: 1, read_updated_at: "old-read" });
    library.db.createWish(wish({ library_book_id: id, title: "旧标题", author: "旧作者" }));
    ensureTrackerConsistencyForMeta(meta, library); const expected = reference("tracker-ensure");
    expect(library.listBooks()).toEqual(expected.books); expect(normalizedWishes(library.db.listWishes())).toEqual(normalizedWishes(expected.wishes));
    expect(meta.read_updated_at).toBe("old-read");
  });
  it.each([null, "不同作者"])("links compatible authors or creates a distinct tracker (%s)", author => {
    const meta = createBook(library, id); library.db.createWish(wish({ author }));
    ensureTrackerConsistencyForMeta(meta, library);
    expect(library.db.listWishes()).toHaveLength(author ? 2 : 1);
    expect(library.db.getWishByLibraryBookId(id)?.rating).toBe(author ? null : 5);
  });
});

function seedEdit(kind: string, oldCover = true) {
  const meta = createBook(library, id, { source_type: kind === "epub" ? "epub" : "txt", theme_template: "__book__", custom_css: "p {color:blue}", status: "dirty" }, kind === "txt");
  const book = bookFromDict({ title: "同名书", author: "作者", root_chapters: [{ title: "第一章", lines: ["保留正文"] }] });
  if (oldCover) meta.cover_file = saveCoverBytes(library.base, id, png, "old.png");
  writeFileSync(epubPath(library.base, id), buildEpub(book, meta, { cover: oldCover ? { name: "old.png", data: png } : null, css_text: "p{color:red}" }));
  library.saveMetadata(meta); return meta;
}
function coverBytes() { return Buffer.from(extractCover(readFileSync(epubPath(library.base, id)))![0]); }
describe("durable edit write-back via the real queue consumer", () => {
  it.each(["epub", "txt", "txt-no-source"])("carries file/URL/strip options from B to C and matches legacy: %s", async kind => {
    seedEdit(kind);
    const f = form({ title: "编辑标题", author: "作者", theme_template: "default", custom_css: "p {color:blue}", cover_url: "https://img.doubanio.com/unused.png", strip_original_css: "on" });
    f.set("cover_file", new File([newPng], "new.png")); expect(await saveBookEdit(id, f, library)).toMatchObject({ queued: true });
    const job = library.db.listJobs()[0]!; expect(job.log).toBeNull(); expect(loadEditWriteback(library, job.id).cover_bytes).toEqual(newPng);
    const fetcher = vi.fn().mockRejectedValue(new Error("file takes precedence"));
    const restarted = new LibraryStorage(library.base, new BinderyDatabase(library.db.path)); recoverJobs(restarted); expect(await drainJobs(restarted, fetcher)).toBe(1); expect(fetcher).not.toHaveBeenCalled();
    const expected = reference(`edit-${kind}`);
    const actual = library.loadMetadata(id); const normalize = (m: Metadata) => ({ ...m, updated_at: "TIME", epub_updated_at: "TIME" });
    expect(normalize(actual)).toEqual(normalize(expected.meta as Metadata)); expect(library.db.getJob(job.id)?.status).toBe("success");
    expect(coverBytes()).toEqual(newPng); expect(existsSync(queueDirectory(library, job.id))).toBe(false);
    const members = readArchive(readFileSync(epubPath(library.base, id))).map(member => [member.name, digest(member.name.endsWith(".opf") ? Buffer.from(new TextDecoder().decode(member.data).replace(/(<(?:\w+:)?meta property="dcterms:modified">)[^<]+/g, "$1TIME")) : member.data)]);
    expect(members).toEqual(expected.members);
    if (kind === "txt") expect(readFileSync(join(library.base, id, "book.json"), "utf8").replace(iso, "TIME")).toBe(expected.book_json);
  });
  it("downloads a cover with Douban headers then refreshes the EPUB cover", async () => {
    seedEdit("epub"); const job = enqueueEditWriteback({ book_id: id, ...options(), cover_url: "https://img.doubanio.com/download.png" }, library).job;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers); expect(headers.get("Referer")).toBe("https://book.douban.com/"); expect(headers.get("User-Agent")).toContain("Chrome/123"); expect(headers.get("Accept")).toContain("image/"); expect(headers.get("Accept-Language")).toContain("zh-CN"); expect(headers.get("Cache-Control")).toBe("no-cache"); expect(headers.get("Pragma")).toBe("no-cache"); return new Response(newPng);
    });
    await drainJobs(library, fetcher); expect(fetcher).toHaveBeenCalledOnce(); expect(coverBytes()).toEqual(newPng); expect(library.loadMetadata(id).cover_file).toBe("cover.png"); expect(library.db.getJob(job.id)?.status).toBe("success");
  });
  it.each([false, true])("preserves or strips original CSS before injecting composed theme/book CSS (%s)", async strip => {
    seedEdit("epub"); enqueueEditWriteback({ book_id: id, ...options(), strip_original_css: strip }, library); await drainJobs(library);
    const members = readArchive(readFileSync(epubPath(library.base, id))); expect(members.some(m => m.name === "EPUB/Styles/style.css")).toBe(!strip);
    expect(members.filter(m => m.name.endsWith(".css")).map(m => Buffer.from(m.data).toString()).join("\n")).toContain("p {color:blue}");
  });
  it.each([false, true])("removes embedded fonts before injecting theme/book CSS only when asked (%s)", async strip => {
    const meta = seedEdit("epub"); meta.custom_css = 'p {color:blue; font-family: "Reader Keep"}'; library.saveMetadata(meta);
    const path = epubPath(library.base, id), members = readArchive(readFileSync(path));
    const style = members.find(m => m.name === "EPUB/Styles/style.css")!;
    style.data = Buffer.from(`${Buffer.from(style.data).toString()}\n@font-face{font-family:Book;src:url(../Fonts/book.ttf)} p{font-family:Book}`);
    writeFileSync(path, writeArchive([...members, { name: "EPUB/Fonts/book.ttf", data: new Uint8Array([0, 1, 0, 0]) }]));
    enqueueEditWriteback({ book_id: id, ...options(), strip_fonts: strip }, library); await drainJobs(library);
    const after = readArchive(readFileSync(path)), css = after.filter(m => m.name.endsWith(".css")).map(m => Buffer.from(m.data).toString()).join("\n");
    expect(after.some(m => m.name === "EPUB/Fonts/book.ttf")).toBe(!strip);
    expect(css.includes("@font-face")).toBe(!strip); expect(css.includes("font-family:Book")).toBe(!strip);
    // The book's own CSS is injected afterwards, so its font choice survives the strip.
    expect(css).toContain('font-family: "Reader Keep"');
  });
  it("still accepts an edit task staged before strip_fonts existed", () => {
    const { job } = enqueueEditWriteback({ book_id: id, ...options() }, library), task = join(queueDirectory(library, job.id), "task.json");
    const spec = JSON.parse(readFileSync(task, "utf8")); delete spec.strip_fonts; writeFileSync(task, JSON.stringify(spec));
    expect(loadEditWriteback(library, job.id).strip_fonts).toBe(false);
  });
  it.each(["txt", "txt-no-source"])("extracts the original TXT cover instead of a stale metadata sidecar: %s", async kind => {
    const meta = seedEdit(kind); meta.cover_file = saveCoverBytes(library.base, id, newPng, "stale.jpg"); library.saveMetadata(meta);
    enqueueEditWriteback({ book_id: id, ...options() }, library); await drainJobs(library); expect(coverBytes()).toEqual(png); expect(library.loadMetadata(id).cover_file).toBe("cover.png");
  });
  it("clears an obsolete TXT sidecar when the original EPUB has no cover", async () => {
    const meta = seedEdit("txt", false); meta.cover_file = saveCoverBytes(library.base, id, png, "stale.png"); library.saveMetadata(meta);
    enqueueEditWriteback({ book_id: id, ...options() }, library); await drainJobs(library); expect(extractCover(readFileSync(epubPath(library.base, id)))).toBeNull(); expect(library.loadMetadata(id).cover_file).toBeNull();
  });
  it("preserves a TXT sidecar when extracting the original cover fails", async () => {
    seedEdit("txt"); writeFileSync(epubPath(library.base, id), "bad zip"); enqueueEditWriteback({ book_id: id, ...options() }, library); await drainJobs(library); expect(coverBytes()).toEqual(png);
  });
  it.each(["download", "epub", "descriptor", "cover"])("marks both metadata and job failed, cleans parameters, and continues the queue: %s", async failure => {
    seedEdit("epub"); const job = enqueueEditWriteback({ book_id: id, ...options(), cover_bytes: failure === "cover" ? newPng : null, cover_url: failure === "download" ? "https://img.doubanio.com/fail.png" : "" }, library).job;
    if (failure === "epub") writeFileSync(epubPath(library.base, id), "bad zip");
    if (failure === "descriptor") rmSync(queueDirectory(library, job.id), { recursive: true });
    if (failure === "cover") rmSync(join(queueDirectory(library, job.id), "cover"));
    await drainJobs(library, async () => new Response("", { status: 502 }));
    expect(library.db.getJob(job.id)).toMatchObject({ status: "failed", stage: "失败", message: "写回失败" }); expect(library.loadMetadata(id).status).toBe("failed"); expect(existsSync(queueDirectory(library, job.id))).toBe(false);
  });
  it("cleans staged options on queue-full and publication errors", () => {
    seedEdit("epub"); vi.stubEnv("BINDERY_INGEST_QUEUE_MAXSIZE", "1"); enqueueJob({ book_id: id }, library);
    const result = enqueueEditWriteback({ book_id: id, ...options(), cover_bytes: newPng }, library); expect(result.queued).toBe(false); expect(existsSync(queueDirectory(library, result.job.id))).toBe(false);
    vi.spyOn(library.db, "withConnection").mockImplementation(() => { throw new Error("publish failed"); });
    expect(() => enqueueEditWriteback({ book_id: id, ...options(), cover_bytes: newPng }, library)).toThrow("publish failed");
    expect(readdirSync(join(library.base, ".ingest-queue"))).toEqual([]);
  });
  it("resumes staged file options in an actual restarted worker and cleans interrupted options", async () => {
    seedEdit("txt"); const { job } = enqueueEditWriteback({ book_id: id, ...options(), cover_bytes: newPng, cover_name: "new.png" }, library);
    const restarted = new LibraryStorage(library.base, new BinderyDatabase(library.db.path)); startJobWorker(restarted);
    await vi.waitFor(() => expect(library.db.getJob(job.id)?.status).toBe("success"), { timeout: 15000 }); await stopJobWorker(restarted);
    expect(coverBytes()).toEqual(newPng); expect(existsSync(queueDirectory(library, job.id))).toBe(false);
    const interrupted = enqueueEditWriteback({ book_id: id, ...options(), cover_bytes: png }, library).job; library.db.updateJob(interrupted.id, { stage: "写回 EPUB" }); recoverJobs(library);
    expect(library.db.getJob(interrupted.id)?.status).toBe("failed"); expect(library.loadMetadata(id).status).toBe("failed"); expect(existsSync(queueDirectory(library, interrupted.id))).toBe(false);
  });
});
