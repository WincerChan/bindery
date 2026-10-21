import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
const normalizeText = (text: string, id: string) => text.replaceAll(id, "<book_id>").replace(iso, "<time>");
const normalize = (value: unknown, id: string): unknown =>
  Array.isArray(value) ? value.map(item => normalize(item, id)) :
  value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "book_id" || key === "library_book_id" ? (item === null ? null : "<book_id>") : key === "created_at" || key === "updated_at" || key === "epub_updated_at" || key === "read_updated_at" ? (item ? "<time>" : item) : normalize(item, id)])) :
  typeof value === "string" ? normalizeText(value, id) : value;

describe("frozen legacy ingest worker reference", () => {
  it.each([
    { name: "parsed identity, intro and volumes", filename: "source.txt", content: "《对照书》\n作者：参考作者\n简介：这是简介\n\n第一卷 开始\n第一章 起点\n第一段\n\n第二段\n第二章 继续\n后文", fields: {}, regenerate: false },
    { name: "filename fallback and metadata overrides", filename: "《七界第一仙》（校对版全本）作者：流牙.txt", content: "==========================================================\n\n第1章 起始\n正文内容\n", fields: { language: "zh", publisher: "出版社", tags: "甲,乙，甲", rating: "4", custom_css: "p { color: black; }", series: "系列", identifier: "123", published: "2026", isbn: "978-123" }, regenerate: false },
    { name: "regeneration keeps metadata and stream stubs", filename: "regen.txt", content: "《原书》\n作者：原作者\n简介：介绍\n\n第一章 起点\n正文", fields: { title: "修改标题", author: "修改作者", description: "手写简介" }, regenerate: true },
  ].map((scenario, index) => ({ ...scenario, index })))("matches book.json, EPUB members, metadata and tracker: $name", async (scenario) => {
    const dir = mkdtempSync(join(root, "case-")), fields = { ...emptyFields(), ...scenario.fields };
    vi.stubEnv("BINDERY_TEMPLATE_DIR", join(dir, "templates")); vi.stubEnv("BINDERY_RULES_DIR", ""); vi.stubEnv("BINDERY_THEMES_DIR", ""); vi.stubEnv("BINDERY_STAGE_DIR", join(dir, "ts-stage"));
    const library = new LibraryStorage(join(dir, "ts"), new BinderyDatabase(join(dir, "ts", "db.sqlite"))); library.ensure();
    const form = new FormData(); form.append("files", new File([scenario.content], scenario.filename, { type: "text/plain" })); for (const [k, v] of Object.entries(fields)) form.append(k, v);
    await submitUploads(library, form); (await drainJobs(library)); const meta = library.listBooks()[0]!;
    if (scenario.regenerate) { regenerateBook(library, meta.book_id, new FormData()); (await drainJobs(library)); }
    const reference = JSON.parse(readFileSync(resolve("tests-ts/fixtures/parity/ingest", `scenario-${scenario.index}.json`), "utf8"));
    expect(normalize(library.loadMetadata(meta.book_id) as unknown, meta.book_id)).toEqual(reference.meta);
    expect(normalizeText(readFileSync(join(library.base, meta.book_id, "book.json"), "utf8"), meta.book_id)).toBe(reference.book_json);
    expect(readFileSync(join(library.base, meta.book_id, "source.txt"), "utf8")).toBe(reference.source);
    const actual = readArchive(readFileSync(epubPath(library.base, meta.book_id))).map(entry => [entry.name, normalizeText(new TextDecoder().decode(entry.data), meta.book_id)]);
    expect(actual.map(([name]) => name)).toEqual(reference.epub.map(([name]: [string, string]) => name));
    expect(actual).toEqual(reference.epub);
    const wish = library.db.getWishByLibraryBookId(meta.book_id)!; const { id: _id, ...actualWish } = normalize(wish as unknown, meta.book_id) as Record<string, unknown>;
    const { id: _pid, ...expectedWish } = reference.wish;
    expect(actualWish).toEqual(expectedWish);
  });
});
