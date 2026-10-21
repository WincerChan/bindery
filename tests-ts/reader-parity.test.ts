import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { readArchive, writeArchive } from "../src/core/archive";
import { epubPath } from "../src/server/storage";
import { loadReader, previewRedirect, saveProgress } from "../src/server/reader/service";
import { extractSearchText, searchBook } from "../src/server/reader/search";
import { readerFixture, readerRequest } from "./fixtures/reader/support";

let fixtures: ReturnType<typeof readerFixture>[] = [];
const fixture = () => { const value = readerFixture(); fixtures.push(value); return value; };
afterEach(() => { vi.useRealTimers(); fixtures.forEach(value => value.cleanup()); fixtures = []; });
const reference = (name: string) => JSON.parse(readFileSync(resolve("tests-ts/fixtures/parity/reader", `${name}.json`), "utf8"));
describe("reader legacy parity with isolated temporary libraries", () => {
  it("matches full search payloads for whitespace, case, offsets, limits, entities and fresh scans", async () => {
    const { library, id, root } = fixture();
    const cases: [string, number, number][] = [["", 10, 0], [" \t\n", 10, 0], [" BETA ", 1, 0], ["beta", 1, 1], ["beta", 1, 2], ["beta", 10, 99], ["no match", 100, 0], ["测试书", 10, 0], ["absent", 10, 0]];
    const expected = reference("search-initial");
    for (let i = 0; i < cases.length; i++) {
      const [q, limit, offset] = cases[i];
      expect(await searchBook(readerRequest("/?" + new URLSearchParams({ q, limit: String(limit), offset: String(offset) })), id, library).json()).toEqual(expected[i]);
    }
    const path = epubPath(library.base, id), entries = readArchive(readFileSync(path));
    writeFileSync(path, writeArchive(entries.map(entry => entry.name.endsWith(".xhtml") ? { ...entry, data: new TextEncoder().encode(new TextDecoder().decode(entry.data).replaceAll("beta", "😀 &NotEqualTilde; &#x80; keyword")) } : entry)));
    const changed = reference("search-changed")[0];
    expect(await searchBook(readerRequest("/?q=keyword&limit=1"), id, library).json()).toEqual(changed);
  });
  it("matches legacy HTML extraction including HTML5/legacy/numeric entities and invalid codepoints", async () => {
    const { root } = fixture();
    const texts = ["<p>😀 ALPHA&nbsp;beta</p><script>hidden</script><STYLE>ignored</STYLE>", "<p>&notit; &nbsp without semi &copy &NotEqualTilde; &#x80; &#13; &#0; &#xD800; &#x110000; &#xFFFF; &#xFDD0; &#x7f;</p>", "<title>书名</title><p>\u0085\u001c 正文\u3000\ufeff</p>", "&lt;script&gt;is text&lt;/script&gt; &unknown; &amp;lt;", "<p>alpha</p><p>beta</p>"];
    const expected = reference("text");
    expect(texts.map(text => extractSearchText(new TextEncoder().encode(text)))).toEqual(expected);
  });
  it("matches progress responses and exact DB rows in alternating legacy/TS writes without EPUB side effects", async () => {
    const { library, id, root } = fixture();
    const payloads = [{ section: 2, page: 5, page_count: 12 }, { section: -8, page: 1000000, page_count: -2 }, { section: 2.9, page: " 1_002 ", page_count: true }, { section: null, page: "2.3", page_count: [] }, { section: "\u001c+１２", page: "١٢", page_count: "𝟠" }, {}];
    const path = epubPath(library.base, id), hash = () => createHash("sha256").update(readFileSync(path)).digest("hex"), before = hash();
    const expected = reference("progress");
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
    for (let i = 0; i < payloads.length; i++) {
      const response = await saveProgress(readerRequest("/", { method: "POST", body: JSON.stringify(payloads[i]) }), id, library);
      expect(await response.json()).toEqual(expected[i].response);
      expect(library.db.getReaderProgress(id)).toEqual(expected[i].row);
    }
    vi.useRealTimers();
    expect(hash()).toBe(before);
    // The recorded legacy run left this row; write the same payload through TS
    // before loading, since legacy no longer executes during the suite.
    const observed = reference("progress-observed")[0];
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
    const observedResponse = await saveProgress(readerRequest("/", { method: "POST", body: JSON.stringify({ section: 0, page: 3, page_count: 8 }) }), id, library);
    expect(await observedResponse.json()).toEqual(observed.response);
    expect(library.db.getReaderProgress(id)).toEqual(observed.row);
    vi.useRealTimers();
    expect(loadReader(id, "0", "/", library).initial_progress).toEqual(observed.row); expect(hash()).toBe(before);
  });
  it("matches preview redirects, resume flags, no-store headers and section context", async () => {
    const { library, id, root } = fixture();
    const query = new URLSearchParams({ return_to: "/jobs?tab=success#ignored" }).toString();
    const expected = reference("preview");
    const response = previewRedirect(readerRequest("/?" + query), id, library);
    expect(response.status).toBe(expected.status); expect(response.headers.get("location")).toBe(expected.location);
    for (const name of ["cache-control", "cdn-cache-control", "pragma", "expires"]) expect(response.headers.get(name)).toBe(expected.headers[name]);
    const data = loadReader(id, "0", "/", library); expect(data.sections).toEqual(expected.sections); expect(data.initial_progress).toEqual(expected.progress);
  });
});
