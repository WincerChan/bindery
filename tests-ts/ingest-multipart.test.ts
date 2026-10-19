import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LibraryStorage } from "../src/server/storage";
import { BinderyDatabase } from "../src/server/db";
import { uploadForm } from "../src/server/ingest/multipart";
import { previewUploads } from "../src/server/ingest/preview";
import { submitUploads } from "../src/server/ingest/actions";
import { drainJobs } from "../src/server/ingest/queue";
const root = mkdtempSync(join(tmpdir(), "bindery-multipart-")); let library: LibraryStorage, seq = 0;
beforeEach(() => { const dir = join(root, String(seq++)); library = new LibraryStorage(join(dir, "library"), new BinderyDatabase(join(dir, "db"))); library.ensure(); vi.stubEnv("BINDERY_TEMPLATE_DIR", join(dir, "templates")); vi.stubEnv("BINDERY_STAGE_DIR", join(dir, "stage")); });
afterEach(() => vi.unstubAllEnvs()); afterAll(() => rmSync(root, { recursive: true, force: true }));
function request(bytes: Uint8Array, boundary = "test-boundary", size = 1) { let offset = 0; return new Request("http://localhost/ingest", { method: "POST", headers: { "Content-Type": `multipart/form-data; boundary="${boundary}"` }, body: new ReadableStream({ pull(controller) { if (offset === bytes.length) controller.close(); else { controller.enqueue(bytes.slice(offset, offset + size)); offset = Math.min(bytes.length, offset + size); } } }), duplex: "half" } as RequestInit); }
function wire(content: string, suffix = "--test-boundary--\r\n") { return Buffer.from(`--test-boundary\r\nContent-Disposition: form-data; name="title"\r\n\r\n中文标题\r\n--test-boundary\r\nContent-Disposition: form-data; name="files"; filename="中文.txt"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n${suffix}`); }
describe("streaming multipart upload transport", () => {
  it.each([1, 2, 17, 65536])("spools files across %i-byte chunk boundaries and retains repeated fields", async size => {
    const text = "第一章 开始\n正文\r\n--test-boundaryXmore";
    const result = await uploadForm(request(wire(text), "test-boundary", size), library);
    expect(result.form.get("title")).toBe("中文标题"); const file = result.form.get("files") as File; expect(file.name).toBe("中文.txt"); expect(await file.text()).toBe(text);
    const previews = await previewUploads(library, [file]); expect(previews[0]?.format).toBe("TXT"); expect(previews[0]?.chapters).toBe(1);
    result.cleanup(); expect(readdirSync(join(library.base, ".ingest-queue", ".requests"))).toEqual([]);
  });
  it("round-trips native Fetch FormData with duplicate file fields and binary cover", async () => {
    const data = new FormData(); data.append("files", new File(["第一章 开始\n正文"], "one.txt")); data.append("files", new File(["第二章 继续\n正文"], "two.txt")); data.append("cover_file", new File([Uint8Array.from([137,80,78,71,13,10,26,10])], "cover.png", { type: "image/png" }));
    const result = await uploadForm(new Request("http://localhost/ingest", { method: "POST", body: data }), library);
    expect(result.form.getAll("files")).toHaveLength(2); expect((await submitUploads(library, result.form) as Response).status).toBe(303); result.cleanup(); expect((await drainJobs(library))).toBe(2); expect(library.listBooks().every(m => m.cover_file === "cover.png")).toBe(true);
  });
  it("accepts empty multipart forms and enforces field limits without retaining files", async () => {
    const parsed = await uploadForm(new Request("http://localhost/ingest", { method: "POST", body: new FormData() }), library); expect([...parsed.form]).toEqual([]); parsed.cleanup();
    const huge = Buffer.from(`--test-boundary\r\nContent-Disposition: form-data; name="custom_css"\r\n\r\n${"x".repeat(1024 * 1024 + 1)}\r\n--test-boundary--\r\n`);
    await expect(uploadForm(request(huge, "test-boundary", 65536), library)).rejects.toThrow("Part exceeded maximum size"); expect(readdirSync(join(library.base, ".ingest-queue", ".requests"))).toEqual([]);
  });
  it("rejects malformed/truncated bodies and removes partial files", async () => {
    await expect(uploadForm(request(wire("first", "")), library)).rejects.toThrow("There was an error parsing the body"); expect(readdirSync(join(library.base, ".ingest-queue", ".requests"))).toEqual([]);
    await expect(uploadForm(new Request("http://localhost/ingest", { method: "POST", headers: { "Content-Type": "multipart/form-data" }, body: "bad" }), library)).rejects.toThrow("Missing boundary");
  });
  it("cleans up after aborted body streams and supports URL-encoded forms", async () => {
    let once = false; const body = new ReadableStream({ pull(c) { if (once) c.error(new Error("stream interrupted")); else { once = true; c.enqueue(wire("first", "")); } } });
    await expect(uploadForm(new Request("http://localhost/ingest", { method: "POST", body, headers: { "Content-Type": "multipart/form-data; boundary=test-boundary" }, duplex: "half" } as RequestInit), library)).rejects.toThrow("stream interrupted"); expect(readdirSync(join(library.base, ".ingest-queue", ".requests"))).toEqual([]);
    const parsed = await uploadForm(new Request("http://localhost/ingest", { method: "POST", body: new URLSearchParams({ rule_template: "default" }) }), library); expect(parsed.form.get("rule_template")).toBe("default"); parsed.cleanup();
  });
});
