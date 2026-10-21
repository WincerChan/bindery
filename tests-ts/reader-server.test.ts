import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readArchive, writeArchive } from "../src/core/archive";
import { listEpubSections } from "../src/core/epub";
import { epubPath } from "../src/server/storage";
import { authenticatedRoute } from "../src/server/http";
import { signIn } from "../src/server/auth";
import { epubResource, isolatedBookHtml, validateItemPath } from "../src/server/reader/resources";
import { loadReader, previewRedirect, saveProgress } from "../src/server/reader/service";
import { extractSearchText, normalizeSearchText, searchBook, searchDocuments } from "../src/server/reader/search";
import type { EpubSectionDocument } from "../src/core/epub";
import { readerFixture, readerRequest } from "./fixtures/reader/support";

let fixtures: ReturnType<typeof readerFixture>[] = [];
const fixture = (...args: Parameters<typeof readerFixture>) => { const value = readerFixture(...args); fixtures.push(value); return value; };
afterEach(() => { fixtures.forEach(value => value.cleanup()); fixtures = []; vi.unstubAllEnvs(); });
const encode = (text: string) => new TextEncoder().encode(text);
const document = (index: number, text: string, media_type = "application/xhtml+xml"): EpubSectionDocument => ({ index, title: String.fromCharCode(65 + index), item_path: `Text/${index}.xhtml`, content: encode(text), media_type });

describe("reader preview and progress (legacy route assertions)", () => {
  it("redirects preview/ to section zero with resume, safe return_to and no-store headers", () => {
    const { library, id } = fixture();
    const response = previewRedirect(readerRequest(`/book/${id}/preview?return_to=%2Fjobs%3Ftab%3Dsuccess%23ignored`), id, library);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/book/${id}/preview/0?resume=1&return_to=%2Fjobs%3Ftab%3Dsuccess`);
    expect(response.headers.get("cache-control")).toContain("no-store"); expect(response.headers.get("cdn-cache-control")).toBe("no-store");
  });
  it.each(["https://evil.test", "//evil.test", "/\\evil.test", "/\u0000x"])("rejects unsafe return target %s", target => {
    const { library, id } = fixture();
    const response = previewRedirect(readerRequest(`/book/${id}/preview?${new URLSearchParams({ return_to: target })}`), id, library);
    expect(response.headers.get("location")).toBe(`/book/${id}/preview/0?resume=1`);
  });
  it("persists all progress fields and supplies the row in preview context without changing EPUB", async () => {
    const { library, id } = fixture(), path = epubPath(library.base, id), before = readFileSync(path);
    const response = await saveProgress(readerRequest("/", { method: "POST", body: JSON.stringify({ section: 2, page: 5, page_count: 12 }) }), id, library);
    expect(await response.json()).toEqual({ ok: true, book_id: id, section: 2, page: 5, page_count: 12 });
    const row = library.db.getReaderProgress(id)!;
    expect(row).toMatchObject({ book_id: id, section: 2, page: 5, page_count: 12 }); expect(Date.parse(row.updated_at)).toBeGreaterThan(0);
    const data = loadReader(id, "0", "/jobs?tab=success", library);
    expect(data.initial_progress).toEqual(row); expect(data.return_to).toBe("/jobs?tab=success");
    expect(data.sections).toEqual(listEpubSections(before)); expect(data.section_index).toBe(0);
    expect(readFileSync(path)).toEqual(before); expect(JSON.stringify(data)).not.toContain(library.base);
  });
  it("upserts a single row, accepts cover sentinel -1, and clamps independent fields", async () => {
    const { library, id } = fixture();
    for (const payload of [{ section: 9, page: 5, page_count: 3 }, { section: -90, page: "1_002", page_count: 1e20 }]) await saveProgress(readerRequest("/", { method: "POST", body: JSON.stringify(payload) }), id, library);
    expect(library.db.getReaderProgress(id)).toMatchObject({ section: -1, page: 1002, page_count: 999999 });
    expect(library.db.all("SELECT * FROM reader_progress")).toHaveLength(1);
  });
  it.each([
    [{ section: 2.9, page: "5.2", page_count: true }, { section: 2, page: 0, page_count: 1 }],
    [{ section: null, page: [], page_count: {} }, { section: 0, page: 0, page_count: 0 }],
    [{ section: " +2 ", page: -1, page_count: "-9" }, { section: 2, page: 0, page_count: 0 }],
    [{}, { section: 0, page: 0, page_count: 0 }],
  ])("uses legacy int/default semantics for %j", async (payload, expected) => {
    const { library, id } = fixture();
    expect(await (await saveProgress(readerRequest("/", { method: "POST", body: JSON.stringify(payload) }), id, library)).json()).toMatchObject(expected);
  });
  it.each(["null", "[]", "true", '"text"', "{bad"])("rejects non-object/invalid JSON %s without a DB write", async body => {
    const { library, id } = fixture();
    await expect(saveProgress(readerRequest("/", { method: "POST", body }), id, library)).rejects.toMatchObject({ status: 400, detail: "Invalid JSON payload" });
    expect(library.db.getReaderProgress(id)).toBeNull();
  });
  it.each(["-1", "99999"])("rejects missing section %s", section => {
    const { library, id } = fixture(); expect(() => loadReader(id, section, "/", library)).toThrow("章节不存在");
  });
  it.each(["bad", "1.2"])("rejects a non-integer section %s as a validation error", section => {
    const { library, id } = fixture(); expect(() => loadReader(id, section, "/", library)).toThrow("请求参数无效");
  });
  it("returns consistent errors for missing, archived, and missing-EPUB books", async () => {
    const { library, id } = fixture();
    expect(() => loadReader("e".repeat(32), "0", "/", library)).toThrow("书籍不存在");
    rmSync(epubPath(library.base, id));
    expect(() => previewRedirect(readerRequest(), id, library)).toThrow("EPUB 不存在");
    expect(await (await searchBook(readerRequest("/?q="), id, library)).json()).toEqual({ query: "", hits: [], indexed_sections: 0 });
    expect(() => searchBook(readerRequest("/?q=beta"), id, library)).toThrow("EPUB 不存在");
    library.archiveBook(id);
    await expect(saveProgress(readerRequest("/", { method: "POST", body: "{}" }), id, library)).rejects.toThrow("书籍不存在");
  });
  it("applies shared lazy CSS sync when opening a section", () => {
    const { library, id, root } = fixture({ custom_css: "p{color:red}" }); vi.stubEnv("BINDERY_TEMPLATE_DIR", root + "/templates");
    const before = createHash("sha256").update(readFileSync(epubPath(library.base, id))).digest("hex");
    loadReader(id, "0", "/", library);
    expect(createHash("sha256").update(readFileSync(epubPath(library.base, id))).digest("hex")).not.toBe(before);
    expect(library.loadMetadata(id).status).toBe("synced");
    expect(readArchive(readFileSync(epubPath(library.base, id))).some(entry => new TextDecoder().decode(entry.data).includes("p{color:red}"))).toBe(true);
  });
});

describe("reader search runtime", () => {
  it("scans fresh documents on every request and observes EPUB file changes", async () => {
    const { library, id } = fixture();
    const first = await searchBook(readerRequest("/?q=beta"), id, library).json(); expect(first.hits).toHaveLength(2);
    const path = epubPath(library.base, id);
    const entries = readArchive(readFileSync(path));
    writeFileSync(path, writeArchive(entries.map(entry => ({ ...entry, data: encode(new TextDecoder().decode(entry.data).replaceAll("beta", "theta")) }))));
    expect((await searchBook(readerRequest("/?q=beta"), id, library).json()).hits).toHaveLength(0);
  });
  it("counts all nonempty HTML sections after reaching the hit limit and paginates by section hits", () => {
    const docs = [document(0, "<p>keyword keyword here</p>"), document(1, "<p>keyword there</p>"), document(2, "<p>no match</p>"), document(3, "", "text/css")];
    const first = searchDocuments(docs, "keyword", 1);
    expect(first).toMatchObject({ indexed_sections: 3, has_more: true, next_offset: 1 }); expect(first.hits[0]).toMatchObject({ index: 0, title: "A" });
    const second = searchDocuments(docs, "keyword", 1, 1);
    expect(second).toMatchObject({ indexed_sections: 3, has_more: false, next_offset: 2 }); expect(second.hits[0].index).toBe(1);
    expect(searchDocuments(docs, "keyword", 1, 9)).toEqual({ hits: [], indexed_sections: 3, has_more: false, next_offset: 9 });
  });
  it("removes script/style/tag text, decodes entities, normalizes whitespace, and uses Unicode offsets", () => {
    expect(extractSearchText(encode("<style>hidden</style><script>hidden</script><p> alpha&nbsp;&amp;\n beta </p>"))).toBe("alpha & beta");
    expect(normalizeSearchText("\u001c\u0085 hi\u3000there \ufeff")).toBe("hi there \ufeff");
    const result = searchDocuments([document(0, "<p>😀 βETA rest</p>")], "βeta", 10);
    expect(result.hits[0]).toMatchObject({ offset: 2, snippet: "😀 βETA rest" });
  });
  it("matches case-insensitively, normalizes query whitespace, and returns the exact empty/nonempty shapes", async () => {
    const { library, id } = fixture();
    expect(await searchBook(readerRequest("/?q=+%09+"), id, library).json()).toEqual({ query: "", hits: [], indexed_sections: 0 });
    const result = await searchBook(readerRequest("/?q=+BETA+&limit=1&offset=0"), id, library).json();
    expect(result).toMatchObject({ query: "BETA", limit: 1, offset: 0, next_offset: 1, has_more: true }); expect(result.hits).toHaveLength(1);
    expect(await searchBook(readerRequest("/?q=beta&limit=1.0&offset=0_0"), id, library).json()).toEqual(await searchBook(readerRequest("/?q=beta&limit=1&offset=0"), id, library).json());
  });
  it.each(["limit=0", "limit=101", "limit=x", "offset=-1", "offset=1.2", "q=" + "a".repeat(201)])("enforces FastAPI query bounds: %s", query => {
    const { library, id } = fixture(); expect(() => searchBook(readerRequest("/?" + query), id, library)).toThrow("请求参数无效");
  });
  it("clips snippets around the first match using 30/70 Unicode characters", () => {
    const text = "甲".repeat(40) + "keyword" + "乙".repeat(80);
    expect(searchDocuments([document(0, `<p>${text}</p>`)], "keyword", 10).hits[0]).toEqual({ index: 0, title: "A", offset: 40, snippet: "..." + "甲".repeat(30) + "keyword" + "乙".repeat(70) + "..." });
  });
  it("preserves the legacy implementation's unbounded nonnegative search offset as an exact JSON number", async () => {
    const { library, id } = fixture(), offset = "9007199254740993123456789";
    const result = await searchBook(readerRequest(`/?q=beta&offset=${offset}`), id, library).text();
    expect(result).toContain(`"offset":${offset}`); expect(result).toContain(`"next_offset":${offset}`);
    expect(JSON.parse(result)).toMatchObject({ hits: [], has_more: false });
    expect(() => loadReader(id, offset, "/", library)).toThrow("章节不存在");
  });
});

describe("isolated EPUB resource delivery", () => {
  it("uses edgeRevalidateHeaders, correct HTML/CSS content types, and script-free CSP", async () => {
    const { library, id } = fixture();
    const path = listEpubSections(readFileSync(epubPath(library.base, id)))[0].item_path;
    const response = epubResource(readerRequest(), id, path, library);
    expect(response.headers.get("cache-control")).toBe("private, no-cache, must-revalidate");
    for (const header of ["cdn-cache-control", "cloudflare-cdn-cache-control"]) expect(response.headers.get(header)).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache"); expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toContain("sandbox allow-same-origin; default-src 'none'; script-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("form-action 'none'"); expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toContain(`<base href="http://localhost/book/${id}/epub/`);
    const css = readArchive(readFileSync(epubPath(library.base, id))).find(entry => entry.name.endsWith(".css"))!;
    const cssResponse = epubResource(readerRequest(), id, css.name, library);
    expect(cssResponse.headers.get("content-type")).toBe("text/css; charset=utf-8"); expect(await cssResponse.text()).toBe(new TextDecoder().decode(css.data));
    expect(await epubResource(readerRequest("/", { method: "HEAD" }), id, css.name, library).text()).toBe("");
  });
  it.each(["", "/etc/passwd", "../book.json", "Text/../book.json", "Text/./a.xhtml", "Text//a.xhtml", "a\\b", "a\u0000b"])("rejects ambiguous/unsafe member path %j", path => {
    expect(() => validateItemPath(path, new Set([path]))).toThrow("资源不存在");
  });
  it("keeps safe nested Unicode names and returns 404 for an absent member", () => {
    const { library, id } = fixture(); expect(validateItemPath("OEBPS/Text/第一章.xhtml", new Set(["OEBPS/Text/第一章.xhtml"]))).toBe("OEBPS/Text/第一章.xhtml");
    expect(() => epubResource(readerRequest(), id, "absent.xhtml", library)).toThrow("资源不存在");
  });
  it("removes active content/navigation, keeps typography and local images, and escapes text", () => {
    const html = isolatedBookHtml(encode('<html><head><meta http-equiv="refresh" content="0;url=/security"/><base href="https://evil.test"/><style>p{color:red}</style></head><body onload="alert(1)"><script>parent.evil()</script><iframe src="/security"></iframe><form action="/logout"><input /></form><p id="a" style="font-size:20px">正文 &amp; 文本<img src="../Images/封面.png" onerror="alert(1)"/></p><a href="javascript:alert(1)">bad</a><a href="ch2.xhtml#p">next</a></body></html>'), "/book/ddd/epub/Text/", "http://localhost/");
    expect(html).not.toMatch(/onload|onerror|<script|<iframe|<form|javascript:|evil\.test|http-equiv/);
    expect(html).toContain("p{color:red}"); expect(html).toContain('id="a"'); expect(html).toContain("正文 &amp; 文本"); expect(html).toContain("/book/ddd/epub/Images/封面.png".replace("封面", "%E5%B0%81%E9%9D%A2"));
    expect(html).toContain("/book/ddd/epub/Text/ch2.xhtml#p");
  });
  it("preserves root typography selectors and resolves same-document footnotes against the chapter", () => {
    const html = isolatedBookHtml(encode('<html lang="zh" class="theme"><head><style>body.chapter p{color:red}</style></head><body class="chapter" style="font-family:serif"><p id="note">正文</p><a href="#note">注</a></body></html>'), "/book/ddd/epub/Text/", "http://localhost/book/ddd/epub/Text/ch1.xhtml");
    expect(html).toContain('<html lang="zh" class="theme">'); expect(html).toContain('<body class="chapter" style="font-family:serif">'); expect(html).toContain('href="http://localhost/book/ddd/epub/Text/ch1.xhtml#note"');
  });
  it("authenticates all API surfaces and maps reader errors to JSON", async () => {
    const { library, id } = fixture();
    const functions = [({ request }: { request: Request }) => epubResource(request, id, "absent", library), ({ request }: { request: Request }) => searchBook(request, id, library), ({ request }: { request: Request }) => saveProgress(request, id, library)];
    for (const handler of functions) {
      const route = authenticatedRoute(handler, () => library);
      expect((await route({ request: readerRequest(), params: {} })).status).toBe(303);
    }
    const route = authenticatedRoute(({ request }) => epubResource(request, id, "absent", library), () => library);
    const response = await route({ request: readerRequest("/", { headers: { Cookie: `bindery_session=${signIn(library.db)}` } }), params: {} });
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ detail: "资源不存在" }); expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
