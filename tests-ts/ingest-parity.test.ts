import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LibraryStorage, epubPath } from "../src/server/storage";
import { BinderyDatabase } from "../src/server/db";
import { submitUploads, regenerateBook } from "../src/server/ingest/actions";
import { emptyFields } from "../src/server/ingest/processor";
import { drainJobs } from "../src/server/ingest/queue";
import { readArchive } from "../src/core/archive";

const root = mkdtempSync(join(tmpdir(), "bindery-ingest-parity-"));
afterAll(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const normalizeMeta = (m: Record<string, unknown>) => Object.fromEntries(Object.entries(m).filter(([key]) => !["created_at", "updated_at", "epub_updated_at", "read_updated_at"].includes(key)));
const normalizeXml = (text: string) => text.replace(/(property="dcterms:modified">)[^<]*/g, "$1__MODIFIED__");

describe("Python ingest worker parity", () => {
  it.each([
    { name: "parsed identity, intro and volumes", filename: "source.txt", content: "《对照书》\n作者：参考作者\n简介：这是简介\n\n第一卷 开始\n第一章 起点\n第一段\n\n第二段\n第二章 继续\n后文", fields: {}, regenerate: false },
    { name: "filename fallback and metadata overrides", filename: "《七界第一仙》（校对版全本）作者：流牙.txt", content: "==========================================================\n\n第1章 起始\n正文内容\n", fields: { language: "zh", publisher: "出版社", tags: "甲,乙，甲", rating: "4", custom_css: "p { color: black; }", series: "系列", identifier: "123", published: "2026", isbn: "978-123" }, regenerate: false },
    { name: "regeneration keeps metadata and stream stubs", filename: "regen.txt", content: "《原书》\n作者：原作者\n简介：介绍\n\n第一章 起点\n正文", fields: { title: "修改标题", author: "修改作者", description: "手写简介" }, regenerate: true },
  ])("matches book.json, EPUB members, metadata and tracker: $name", async (scenario) => {
    const dir = mkdtempSync(join(root, "case-")), fields = { ...emptyFields(), ...scenario.fields };
    vi.stubEnv("BINDERY_TEMPLATE_DIR", join(dir, "templates")); vi.stubEnv("BINDERY_RULES_DIR", ""); vi.stubEnv("BINDERY_THEMES_DIR", ""); vi.stubEnv("BINDERY_STAGE_DIR", join(dir, "ts-stage"));
    const library = new LibraryStorage(join(dir, "ts"), new BinderyDatabase(join(dir, "ts", "db.sqlite"))); library.ensure();
    const form = new FormData(); form.append("files", new File([scenario.content], scenario.filename, { type: "text/plain" })); for (const [k, v] of Object.entries(fields)) form.append(k, v);
    await submitUploads(library, form); (await drainJobs(library)); const meta = library.listBooks()[0]!;
    if (scenario.regenerate) { regenerateBook(library, meta.book_id, new FormData()); (await drainJobs(library)); }
    writeFileSync(join(dir, "source.txt"), scenario.content);
    writeFileSync(join(dir, "input.json"), JSON.stringify({ book_id: meta.book_id, fields, filename: scenario.filename, regenerate: scenario.regenerate }));
    await promisify(execFile)("uv", ["run", "--no-sync", "python", resolve("tests-ts/fixtures/ingest/reference.py"), dir], { env: { ...process.env, UV_CACHE_DIR: "/tmp/bindery-uv-cache" }, timeout: 20000 });
    const reference = JSON.parse(readFileSync(join(dir, "reference.json"), "utf8"));
    expect(normalizeMeta(library.loadMetadata(meta.book_id) as unknown as Record<string, unknown>)).toEqual(normalizeMeta(reference.meta));
    expect(readFileSync(join(library.base, meta.book_id, "book.json"), "utf8")).toBe(readFileSync(join(dir, "python", meta.book_id, "book.json"), "utf8"));
    expect(readFileSync(join(library.base, meta.book_id, "source.txt"))).toEqual(readFileSync(join(dir, "python", meta.book_id, "source.txt")));
    const actual = readArchive(readFileSync(epubPath(library.base, meta.book_id))), expected = readArchive(readFileSync(join(dir, "python", meta.book_id, "book.epub")));
    expect(actual.map(m => m.name)).toEqual(expected.map(m => m.name));
    for (let i = 0; i < actual.length; i++) expect(normalizeXml(Buffer.from(actual[i].data).toString("utf8")), actual[i].name).toBe(normalizeXml(Buffer.from(expected[i].data).toString("utf8")));
    const wish = library.db.getWishByLibraryBookId(meta.book_id)!; const { id: _id, ...actualWish } = normalizeMeta(wish as unknown as Record<string, unknown>), { id: _pid, ...expectedWish } = normalizeMeta(reference.wish);
    expect(actualWish).toEqual(expectedWish);
  });
});
