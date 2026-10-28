import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LibraryStorage, bookDir, epubPath, sourcePath, saveBook, writeSourceFile } from "../src/server/storage";
import { BinderyDatabase, nowIso } from "../src/server/db";
import { metadataFromDict, type Job } from "../src/core/models";
import { buildEpub, extractEpubMetadata } from "../src/core/epub";
import { parseBook } from "../src/core/parsing";
import { submitUploads, regenerateBook, regenerateBulk, cleanupInvalid } from "../src/server/ingest/actions";
import { stagedCoverResponse } from "../src/server/ingest/cover";
import { previewUploads } from "../src/server/ingest/preview";
import { stageUpload, stageRoot, cleanupStagedExcept, loadStaged, normalizeTokens, queueDirectory } from "../src/server/ingest/staging";
import { claimJob, drainJobs, recoverJobs, acquireConsumer, trimMemory } from "../src/server/ingest/queue";
import { jobActionLabel, jobView, jobsPayload, invalidJobIds } from "../src/server/ingest/queries";
import { duplicateReason, resolveTxtIdentity } from "../src/server/ingest/identity";
import { updateMetaSynced } from "../src/server/ingest/processor";
import { statusView } from "../src/server/book-view";
import { enqueueJob } from "../src/server/jobs";
import { startJobWorker, stopJobWorker } from "../src/server/ingest/lifecycle";

const root = mkdtempSync(join(tmpdir(), "bindery-ingest-"));
let library: LibraryStorage, seq = 0;
beforeEach(() => {
  const dir = join(root, String(seq++));
  library = new LibraryStorage(join(dir, "library"), new BinderyDatabase(join(dir, "db.sqlite"))); library.ensure();
  vi.stubEnv("BINDERY_TEMPLATE_DIR", join(dir, "templates")); vi.stubEnv("BINDERY_RULES_DIR", ""); vi.stubEnv("BINDERY_THEMES_DIR", ""); vi.stubEnv("BINDERY_STAGE_DIR", join(dir, "stage")); vi.stubEnv("BINDERY_INGEST_QUEUE_MAXSIZE", "64");
});
afterEach(async () => { await stopJobWorker(library); vi.unstubAllEnvs(); });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const upload = (name = "sample.txt", data = "第一章 开始\n正文", type = "text/plain") => new File([data], name, { type });
function form(files: File[] = [upload()], fields: Record<string, string | string[]> = {}): FormData { const data = new FormData(); files.forEach(f => data.append("files", f)); for (const [k, v] of Object.entries(fields)) for (const value of Array.isArray(v) ? v : [v]) data.append(k, value); return data; }
async function submit(data = form()) { const result = await submitUploads(library, data); expect(result).toBeInstanceOf(Response); return result as Response; }
function seed(id = "a".repeat(32), epub = false) { const meta = metadataFromDict({ book_id: id, title: "测试书", author: "作者", source_type: epub ? "epub" : "txt", rule_template: "default", theme_template: "default" }); library.saveMetadata(meta); const book = parseBook("第一章 开始\n正文", "test"); saveBook(book, library.base, id); writeFileSync(epubPath(library.base, id), buildEpub(book, meta)); if (!epub) writeFileSync(sourcePath(library.base, id), "第一章 开始\n正文"); return meta; }
const location = (response: Response) => new URL(response.headers.get("Location")!, "http://localhost");

describe("upload persistence, redirect and worker", () => {
  it("publishes only complete files/descriptors, returns to ingest and consumes a TXT job", async () => {
    const response = await submit(form([upload()], { title: "书名", author: "作者", tags: "甲，乙,甲", rating: "8", language: "zh", description: "简介", series: "系列", identifier: "编号", publisher: "出版", published: "2026", isbn: "123" }));
    expect(response.status).toBe(303); expect(location(response).pathname).toBe("/ingest"); expect(location(response).searchParams.get("toast_kind")).toBe("success");
    const job = library.db.listJobs()[0]!; expect(job.stage).toBe("排队中"); expect(job.status).toBe("running");
    const directory = queueDirectory(library, job.id), spec = JSON.parse(readFileSync(join(directory, "task.json"), "utf8"));
    expect(spec).not.toHaveProperty("data"); expect(readFileSync(join(directory, spec.payload_name), "utf8")).toContain("正文");
    expect((await drainJobs(library))).toBe(1); expect(library.db.getJob(job.id)?.status).toBe("success"); expect(existsSync(directory)).toBe(false);
    const meta = library.listBooks()[0]!; expect(meta).toMatchObject({ title: "书名", author: "作者", rating: 5, tags: ["甲", "乙", "甲"], language: "zh", description: "简介", series: "系列", identifier: "编号", publisher: "出版", published: "2026", isbn: "123", status: "synced" });
    expect(meta.updated_at).toBe(meta.epub_updated_at); expect(statusView(meta).status_class).toBe("ok");
    expect(extractEpubMetadata(readFileSync(epubPath(library.base, meta.book_id)), "fallback").title).toBe("书名");
    expect(readFileSync(sourcePath(library.base, meta.book_id), "utf8")).toContain("正文");
    const book = JSON.parse(readFileSync(join(bookDir(library.base, meta.book_id), "book.json"), "utf8")); expect(book.root_chapters[0].lines).toEqual([]);
    expect(library.db.getWishByLibraryBookId(meta.book_id)?.title).toBe("书名");
  });
  it("does not publish a row while the upload stream is incomplete", async () => {
    const file = upload(); let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    vi.spyOn(file, "stream").mockImplementation(() => new ReadableStream({ start(value) { controller = value; } }));
    const pending = submitUploads(library, form([file]));
    await vi.waitFor(() => expect(controller).toBeDefined());
    controller!.enqueue(Buffer.from("第一章 开始\n"));
    expect(library.db.listJobs()).toHaveLength(0);
    controller!.enqueue(Buffer.from("正文")); controller!.close();
    expect(await pending).toBeInstanceOf(Response); expect(library.db.listJobs()).toHaveLength(1); expect((await drainJobs(library))).toBe(1);
  });
  it("batches uploads and keeps HTMX redirect compatibility", async () => {
    const response = await submitUploads(library, form([upload("one.txt"), upload("two.txt")]), new Request("http://localhost/ingest", { headers: { "HX-Request": "true" } })) as Response;
    expect(response.status).toBe(200); expect(response.headers.get("HX-Redirect")).toContain("/ingest?"); expect(library.db.listJobs()).toHaveLength(2); expect((await drainJobs(library))).toBe(2);
  });
  it("retains failed queue-full rows and removes their payloads", async () => {
    vi.stubEnv("BINDERY_INGEST_QUEUE_MAXSIZE", "1"); await submit();
    const response = await submit(); expect(location(response).searchParams.get("toast_kind")).toBe("error");
    const failed = library.db.listJobs("failed")[0]!; expect(failed).toMatchObject({ stage: "失败", message: "任务队列已满，请稍后重试" }); expect(existsSync(queueDirectory(library, failed.id))).toBe(false);
  });
  it("fails empty/blank/unsupported/malformed EPUB inputs and cleans their queue files", async () => {
    const response = await submit(form([upload("empty.txt", "")])); expect(location(response).searchParams.get("toast_kind")).toBe("warning");
    await submit(form([upload("blank.txt", " \n\t"), upload("binary.bin", "\0\x01", "application/octet-stream"), upload("bad.epub", "broken", "application/epub+zip")]));
    (await drainJobs(library)); const jobs = library.db.listJobs(); expect(jobs).toHaveLength(4); expect(jobs.every(j => j.status === "failed")).toBe(true); expect(jobs.some(j => j.message?.includes("文本为空"))).toBe(true); expect(jobs.some(j => j.message?.includes("不支持"))).toBe(true); expect(jobs.some(j => j.message === "导入失败")).toBe(true);
    expect(readdirSync(join(library.base, ".ingest-queue"))).toEqual([]);
  });
  it("imports EPUB, preserves source theme and rejects regenerating/retrying it", async () => {
    const original = seed(), bytes = readFileSync(epubPath(library.base, original.book_id)); library.deleteBook(original.book_id);
    const data = form([], { theme_template: "__book__" }); data.append("files", new File([bytes], "import.epub", { type: "application/epub+zip" })); await submit(data); (await drainJobs(library));
    const meta = library.listBooks()[0]!; expect(meta).toMatchObject({ source_type: "epub", title: "测试书", theme_template: "__book__", rule_template: null }); expect(existsSync(sourcePath(library.base, meta.book_id))).toBe(false);
    expect(() => regenerateBook(library, meta.book_id, new FormData())).toThrow("EPUB 导入的书籍无法重新生成"); expect(() => regenerateBook(library, "", new FormData(), library.db.listJobs()[0]!.id)).toThrow("EPUB 导入的书籍无法重试生成");
  });
  it("rejects missing selections, stale and invalid tokens", async () => {
    await expect(submitUploads(library, form([]))).rejects.toThrow("Empty file");
    expect(await submitUploads(library, form([], { upload_tokens: "a".repeat(32) }))).toMatchObject({ error: "上传暂存已失效，请重新选择文件后再提交。" });
    expect(normalizeTokens(["../bad", "A".repeat(32), "a".repeat(32)])).toEqual(["a".repeat(32)]);
  });
});

describe("preview, staging and dedupe", () => {
  it("serves staged EPUB covers without importing books and rejects expired or invalid tokens", async () => {
    const cover = Buffer.from("89504e470d0a1a0a", "hex");
    const book = parseBook("第一章 开始\n正文", "test"), meta = metadataFromDict({ title: "有封面的书" });
    const bytes = buildEpub(book, meta, { cover: { name: "cover.png", data: cover } });
    const [preview, txt] = await previewUploads(library, [new File([bytes as BlobPart], "cover.epub"), upload()]);
    expect(preview!.cover_url).toBe(`/ingest/cover?upload_token=${preview!.upload_token}`);
    expect(txt!.cover_url).toBeUndefined();
    const response = stagedCoverResponse(new Request(`https://example.test${preview!.cover_url}`), library);
    expect(response.status).toBe(200); expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(cover);
    expect(library.listBooks()).toHaveLength(0);
    for (const token of ["../payload", "bad", txt!.upload_token!, "f".repeat(32)]) {
      expect(stagedCoverResponse(new Request(`https://example.test/ingest/cover?upload_token=${encodeURIComponent(token)}`), library).status).toBe(404);
    }
    cleanupStagedExcept(library);
    expect(stagedCoverResponse(new Request(`https://example.test${preview!.cover_url}`), library).status).toBe(404);
  });
  it("keeps coverless EPUBs available for ingest with a generated-cover fallback", async () => {
    const bytes = buildEpub(parseBook("第一章 开始\n正文", "test"), metadataFromDict({ title: "无封面的书" }));
    const [preview] = await previewUploads(library, [new File([bytes as BlobPart], "no-cover.epub")]);
    expect(preview!.error).toBeUndefined();
    expect(stagedCoverResponse(new Request(`https://example.test${preview!.cover_url}`), library).status).toBe(404);
  });

  it("streams preview to disk without using File.arrayBuffer, summarizes events and filename identity", async () => {
    const file = upload("《七界第一仙》（校对版全本）作者：流牙.txt", "==========================================================\n\n第1章 起始\n正文内容\n");
    vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("must stream"));
    const previews = await previewUploads(library, [file]); expect(previews[0]).toMatchObject({ title: "七界第一仙", author: "流牙", format: "TXT", chapters: 1, toc: ["第1章 起始"] }); expect(loadStaged(library, previews[0]!.upload_token!)).not.toBeNull();
    await submit(form([], { upload_tokens: previews[0]!.upload_token! })); (await drainJobs(library)); expect(library.listBooks()[0]).toMatchObject({ title: "七界第一仙", author: "流牙" });
  });
  it("handles empty and invalid preview files without exposing library paths", async () => {
    const results = await previewUploads(library, [upload("empty.txt", ""), upload("blank.txt", " \n"), upload("bad.epub", "bad"), upload("bad.bin", "\0", "application/octet-stream")]);
    expect(results.map(p => p.error)).toEqual(["空文件", "文本为空或无法解码", "解析 EPUB 失败", "不支持的文件类型（仅支持 .txt / .epub）"]); expect(results[0]?.upload_token).toBeNull(); expect(results[1]).not.toHaveProperty("path");
  });
  it("keeps selected stage tokens, removes others and rejects descriptor traversal", async () => {
    const a = await stageUpload(library, upload()), b = await stageUpload(library, upload());
    expect(cleanupStagedExcept(library, [a.token])).toBe(1); expect(loadStaged(library, a.token)).not.toBeNull(); expect(loadStaged(library, b.token)).toBeNull();
    writeFileSync(join(stageRoot(library), a.token, "meta.json"), JSON.stringify({ payload_name: "../secret" })); expect(loadStaged(library, a.token)).toBeNull();
  });
  it.each(["", "作者甲"])("normalizes an existing book with incoming author %s and creates no new book", async author => {
    await submit(form([upload()], { title: "重复样例", author: "作者甲" })); (await drainJobs(library)); const existing = library.listBooks()[0]!;
    await submit(form([upload()], { title: "重复样例", author, dedupe_mode: "normalize" })); (await drainJobs(library));
    expect(library.listBooks()).toHaveLength(1); expect(library.db.listJobs().some(j => j.book_id === existing.book_id && j.message === "归一到已入库书籍")).toBe(true);
  });
  it("honors per-file keep overrides and reuses another duplicate", async () => {
    await submit(form([upload()], { title: "重复样例" })); (await drainJobs(library));
    const previews = await previewUploads(library, [upload("one.txt"), upload("two.txt")]);
    await submit(form([], { title: "重复样例", dedupe_mode: "normalize", upload_tokens: previews.map(p => p.upload_token!), dedupe_keep_tokens: previews[0]!.upload_token! })); (await drainJobs(library)); expect(library.listBooks()).toHaveLength(2);
  });
  it("binds an unlinked manual tracker, preserving reading state, rating and notes", async () => {
    library.db.createWish({ id: "f".repeat(32), title: "手动追踪书", author: "手动作者", library_book_id: null, rating: 5, read: false, read_status: "reading", tags: ["待看"], comment: "先记下来", book_status: "ongoing", created_at: "old", updated_at: "old" });
    await submit(form([upload()], { title: "手动追踪书", author: "手动作者" })); (await drainJobs(library));
    const wishes = library.db.listWishes(); expect(wishes).toHaveLength(1); expect(wishes[0]).toMatchObject({ id: "f".repeat(32), read_status: "reading", rating: 5, tags: ["待看"], comment: "先记下来", library_book_id: library.listBooks()[0]!.book_id }); expect(library.listBooks()[0]?.rating).toBe(5);
  });
  it("matches title/author and ISBN precedence", () => {
    const meta = metadataFromDict({ title: "A B", author: "作者甲", isbn: "123-X" });
    expect(duplicateReason("ab", "作者甲", "", meta)).toBe("标题+作者"); expect(duplicateReason("ab", null, "", meta)).toBe("标题"); expect(duplicateReason("ab", "作者乙", "", meta)).toBeNull(); expect(duplicateReason("other", "other", "123x", meta)).toBe("ISBN");
  });
});

describe("regeneration, retry, recovery and job views", () => {
  it("queues regeneration and retry, ignores next and produces synced EPUB via events", async () => {
    const meta = seed(); expect(regenerateBook(library, meta.book_id, form([], { next: "//evil.test" })).headers.get("Location")).toBe("/ingest?jobs_tab=running#jobs");
    const first = library.db.listJobs()[0]!; expect(first.action).toBe("regenerate"); expect((await drainJobs(library))).toBe(1); expect(library.loadMetadata(meta.book_id).status).toBe("synced");
    regenerateBook(library, "", new FormData(), first.id); expect(library.db.listJobs().some(j => j.action === "retry" && j.stage === "排队中")).toBe(true);
    expect(() => regenerateBook(library, "", new FormData(), "missing")).toThrow("任务不存在");
  });
  it("marks failed regeneration metadata and stores a diagnostic log", async () => {
    const meta = seed(); rmSync(sourcePath(library.base, meta.book_id)); enqueueJob({ book_id: meta.book_id }, library); (await drainJobs(library));
    expect(library.db.listJobs()[0]).toMatchObject({ status: "failed", stage: "失败", message: "转换失败" }); expect(library.db.listJobs()[0]?.log).toContain("Source missing"); expect(library.loadMetadata(meta.book_id).status).toBe("failed");
  });
  it("atomically claims once across storage instances and recovers interrupted stages", async () => {
    await submit(); const other = new LibraryStorage(library.base, new BinderyDatabase(library.db.path));
    const claimed = claimJob(library); expect(claimed?.stage).toBe("预处理"); expect(claimJob(other)).toBeNull(); recoverJobs(library);
    expect(library.db.getJob(claimed!.id)).toMatchObject({ status: "failed", message: "后台处理被中断，请重试" }); expect(existsSync(queueDirectory(library, claimed!.id))).toBe(false);
    const release = acquireConsumer(library)!; expect(acquireConsumer(other)).toBeNull(); release(); expect(acquireConsumer(other)).toBeTypeOf("function"); rmSync(join(library.base, ".ingest-queue", ".consumer"), { recursive: true });
  });
  it("recovers queued uploads after a worker restart and starts only one worker per library", async () => {
    await submit(); startJobWorker(library); startJobWorker(library);
    await vi.waitFor(() => expect(library.db.listJobs()[0]?.status).toBe("success"), { timeout: 15000, interval: 50 });
    expect(library.listBooks()).toHaveLength(1);
  }, 20000);
  it("reports missing durable payloads and drains subsequent jobs", async () => {
    await submit(); const job = library.db.listJobs()[0]!; rmSync(queueDirectory(library, job.id), { recursive: true }); await submit(); expect((await drainJobs(library))).toBe(2); expect(library.db.getJob(job.id)?.message).toBe("读取队列文件失败"); expect(library.listBooks()).toHaveLength(1);
  });
  it("handles removed or emptied queued files with the reference failure messages", async () => {
    await submit(); const job = library.db.listJobs()[0]!; const directory = queueDirectory(library, job.id); const spec = JSON.parse(readFileSync(join(directory, "task.json"), "utf8"));
    rmSync(join(directory, spec.payload_name)); (await drainJobs(library)); expect(library.db.getJob(job.id)?.message).toBe("读取队列文件失败");
    await submit(); const next = library.db.listJobs().find(j => j.status === "running")!, nextDirectory = queueDirectory(library, next.id); const nextSpec = JSON.parse(readFileSync(join(nextDirectory, "task.json"), "utf8"));
    writeFileSync(join(nextDirectory, nextSpec.payload_name), ""); (await drainJobs(library)); expect(library.db.getJob(next.id)?.message).toBe("上传文件为空");
  });
  it("filters bulk processing by parsing/theme and uses edit-writeback for EPUB", async () => {
    seed(); seed("b".repeat(32), true); expect(regenerateBulk(library, form([], { scope: "parsing" })).headers.get("Location")).toBe("/ingest?jobs_tab=running#jobs"); expect(library.db.listJobs()).toHaveLength(1);
    regenerateBulk(library, form([], { scope: "themes" })); expect(library.db.listJobs()).toHaveLength(3); expect(library.db.listJobs().some(j => j.action === "edit-writeback")).toBe(true); (await drainJobs(library)); expect(library.db.listJobs().every(j => j.status === "success")).toBe(true);
    expect(() => regenerateBulk(library, form([], { template_id: "missing" }))).toThrow("规则不存在");
  });
  it("shows grouped paginated jobs, archived identities, invalid counts and cleans history", () => {
    const meta = seed(); for (let i = 0; i < 14; i++) enqueueJob({ book_id: meta.book_id }, library);
    enqueueJob({ book_id: null, action: "ingest" }, library); let data = jobsPayload(library, "unknown", 999); expect(data.active_tab).toBe("all"); expect(data.page).toBe(2); expect(data.jobs).toHaveLength(3); expect(data.invalid_job_count).toBe(1);
    library.archiveBook(meta.book_id); data = jobsPayload(library); expect(data.jobs.find(j => j.book_id === meta.book_id)?.book_title).toBe("测试书"); expect(data.jobs.every(j => !j.can_open_book)).toBe(true);
    expect(cleanupInvalid(library, "failed").headers.get("Location")).toBe("/ingest?jobs_tab=failed#jobs"); expect(library.db.listJobs()).toHaveLength(14);
    expect(jobActionLabel("upload-epub")).toBe("EPUB 入库"); expect(jobActionLabel("custom-action")).toBe("custom-action"); expect(jobActionLabel("retry")).toBe("重试生成");
    const missing = jobView(library.db.listJobs()[0]!, new Map()); expect(missing).toMatchObject({ book_title: "未关联书籍", book_author: "未知", can_open_book: false });
  });
  it("defaults to all statuses ordered by creation with group counts and pagination", () => {
    const meta = seed();
    for (let index = 0; index < 15; index++) {
      const status = ["running", "success", "failed"][index % 3]!;
      library.db.createJob({ id: `job-${index}`, book_id: meta.book_id, action: "regenerate", status, stage: status, message: null, log: null, rule_template: "default", created_at: String(index).padStart(2, "0"), updated_at: "2026" });
    }
    const data = jobsPayload(library);
    expect(data).toMatchObject({ active_tab: "all", total_jobs: 15, total_pages: 2 });
    expect(data.jobs.map(job => job.id)).toEqual(Array.from({ length: 12 }, (_, index) => `job-${14 - index}`));
    expect(data.tabs.map(tab => [tab.key, tab.count])).toEqual([["all", 15], ["running", 5], ["success", 5], ["failed", 5]]);
    expect(jobsPayload(library, "all", 2).jobs.map(job => job.id)).toEqual(["job-2", "job-1", "job-0"]);
    expect(jobsPayload(library, "failed").jobs.every(job => job.status === "failed")).toBe(true);
    expect(cleanupInvalid(library, "all").headers.get("Location")).toBe("/ingest?jobs_tab=all#jobs");
  });
  it("sets sync timestamps together and optionally asks V8 to collect", () => {
    const meta = metadataFromDict({ status: "dirty" }); updateMetaSynced(meta); expect(meta.updated_at).toBe(meta.epub_updated_at); expect(statusView(meta).status_label).toBe("已写回元数据");
    const gc = vi.fn(); trimMemory(gc); expect(gc).toHaveBeenCalledOnce(); vi.stubEnv("BINDERY_MEMORY_TRIM", "0"); trimMemory(gc); expect(gc).toHaveBeenCalledOnce();
  });
});
