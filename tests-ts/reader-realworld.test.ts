import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { contentUrl, sectionUrl } from "../src/features/reader/model";
import { encodeEpubPath, resolveEpubReference } from "../src/core/epub-path";
import { loadEpubItem, listEpubSections } from "../src/core/epub";
import { bookEpubNeedsCssSync } from "../src/server/epub-css";
import { ReaderArchiveCache, readerArchives } from "../src/server/reader/archive";
import { epubResource, isolatedBookHtml, rewriteBookCss, validateItemPath } from "../src/server/reader/resources";
import { loadReader, previewRedirect, readBookArchive } from "../src/server/reader/service";
import { searchBook } from "../src/server/reader/search";
import { epubPath } from "../src/server/storage";
import { obfuscatedEpub } from "./fixtures/reader/obfuscated";
import { readerFixture, readerRequest } from "./fixtures/reader/support";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); readerArchives.clear(); });
function fixture() {
  const fixture = readerFixture(), book = obfuscatedEpub(), path = epubPath(fixture.library.base, fixture.id);
  cleanups.push(fixture.cleanup); writeFileSync(path, book.data);
  return { ...fixture, book, path, archive: readBookArchive(fixture.id, fixture.library) };
}

describe("exact EPUB member names and URL round trips", () => {
  it("accepts existing punctuation, literal encodings, spaces and CJK without aliasing", () => {
    const { book, archive } = fixture();
    for (const entry of book.entries) {
      expect(validateItemPath(entry.name, archive)).toBe(entry.name);
      const url = new URL(contentUrl("id", entry.name), "http://localhost");
      expect(url.search).toBe(""); expect(url.hash).toBe("");
      expect(decodeURIComponent(url.pathname.slice("/book/id/epub/".length))).toBe(entry.name);
    }
    for (const token of ["%3A", "%7C", "%2A", "%7E", "%23", "%25", "%3F", "%3C", "%3E", "%22"]) expect(contentUrl("id", book.paths[0])).toContain(token);
    expect(() => validateItemPath("not-present", archive)).toThrow("资源不存在");
    // An existing basename does not authorize aliases through another directory.
    expect(() => validateItemPath(book.paths[0].split("/").at(-1)!, archive)).toThrow("资源不存在");
  });
  it.each(["", "/x", "C:/Windows/x", "../x", "a/../x", "./x", "a/./x", "a//x", "a/", "a\\x", "a\0x", "a\nx", "a\u007fx", "a\u0085x"])("rejects unsafe path even if present: %j", path => {
    expect(() => validateItemPath(path, new Set([path]))).toThrow("资源不存在");
  });
  it("resolves encoded paths once, literal #/?/%, fragments and relative directories by membership", () => {
    const { archive, book } = fixture(), from = book.paths[0];
    expect(resolveEpubReference("OEBPS/package.opf", book.relative(from), archive.has)?.path).toBe(from);
    expect(resolveEpubReference(from, encodeEpubPath(from.split("/").at(-1)!) + "#note", archive.has)).toEqual({ path: from, fragment: "note" });
    expect(resolveEpubReference(from, from.split("/").at(-1)!, archive.has)?.path).toBe(from);
    for (const raw of ["../../../../../outside", "https://evil.test/a", "javascript:alert(1)", "/security", "missing", "a\\b"]) expect(resolveEpubReference(from, raw, archive.has)).toBeNull();
    for (const name of ["%2e%2e", "%2F", "#", "?"]) {
      const path = `OEBPS/Images/${name}`;
      expect(resolveEpubReference(from, "../../../Images/" + encodeEpubPath(name), archive.has)?.path).toBe(path);
    }
  });
  it("renders chapters, images, CSS imports/fonts, inline URLs and footnotes through the resource service", async () => {
    const { id, library, book, archive } = fixture(), url = (path: string) => "http://localhost" + contentUrl(id, path);
    const data = loadReader(id, "0", "/", library);
    expect(data.sections).toEqual(book.paths.map((path, index) => ({ item_path: path, title: `第 ${index} 章` })));
    expect(previewRedirect(readerRequest(), id, library).status).toBe(303);
    const chapter = await epubResource(readerRequest(contentUrl(id, book.paths[0])), id, book.paths[0], library).text();
    for (const path of [book.image, book.css, book.paths[1]]) expect(chapter).toContain(url(path));
    expect(chapter).toContain(url(book.paths[0]) + "#note");
    expect(chapter).not.toMatch(/<script|<form|<input|parent\.attack/);
    const css = await epubResource(readerRequest(contentUrl(id, book.css)), id, book.css, library).text();
    for (const path of [book.image, book.importedCss, book.font]) expect(css).toContain(url(path));
    expect(await epubResource(readerRequest(contentUrl(id, book.importedCss)), id, book.importedCss, library).text()).toContain(url(book.image));
    expect(new Uint8Array(await epubResource(readerRequest(), id, book.image, library).arrayBuffer())).toEqual(archive.read(book.image));
    const search = await searchBook(readerRequest("/?q=needle"), id, library).json();
    expect(search.hits).toHaveLength(3);
    expect(sectionUrl(id, search.hits[1].index, "/", { find: "needle #?%" })).toContain("find=needle+%23%3F%25");
  });
  it("rewrites CSS tokens with escapes and spaces while preserving comments and other strings", () => {
    const resolved: string[] = [], resolve = (raw: string) => { resolved.push(raw); return "http://localhost/" + encodeEpubPath(raw); };
    const css = String.raw`/* url(missing) */ p{content:"url(missing)";background:url("图\20 片\23 %.png")} @import 'a:b.css'; x{background:url(x\)y.png);mask:url("#\d800")}`;
    const result = rewriteBookCss(css, resolve);
    expect(resolved).toEqual(["图 片#%.png", "a:b.css", "x)y.png", "#\ufffd"]);
    expect(result).toContain('/* url(missing) */'); expect(result).toContain('content:"url(missing)"');
    expect(result).toContain("%E5%9B%BE%20%E7%89%87%23%25.png");
  });
});

describe("bounded archive/package cache", () => {
  it("builds once; repeated resource/reader loads read only the requested members", async () => {
    const { archive, book, id, library } = fixture();
    loadReader(id, "0", "/", library);
    const initial = { ...archive.stats };
    for (let i = 0; i < 4; i++) {
      loadReader(id, "1", "/", library);
      await epubResource(readerRequest(), id, book.image, library).arrayBuffer();
    }
    expect(readBookArchive(id, library)).toBe(archive);
    expect(archive.stats.indexBuilds).toBe(1); expect(archive.stats.metadataParses).toBe(1);
    expect(archive.stats.memberReads - initial.memberReads).toBe(4);
    expect(archive.stats.compressedBytesRead - initial.compressedBytesRead).toBe(4 * archive.members.get(book.image)!.compressedSize);
  });
  it.each(["mtime", "size"] as const)("invalidates the index, parsed TOC and resources when %s changes", async kind => {
    const { archive, path, book, id, library } = fixture();
    archive.metadata();
    const before = statSync(path);
    if (kind === "mtime") utimesSync(path, before.atime, new Date(before.mtimeMs + 2000));
    else { writeFileSync(path, obfuscatedEpub(4).data); utimesSync(path, before.atime, before.mtime); }
    const next = readBookArchive(id, library);
    expect(next).not.toBe(archive); expect(next.stats.metadataParses).toBe(0);
    expect(loadReader(id, "0", "/", library).sections).toHaveLength(kind === "mtime" ? 3 : 4);
    expect(await epubResource(readerRequest(), id, book.paths[0], library).text()).toContain("needle");
  });
  it("observes replacement content, removed members and deletion", async () => {
    const { archive, path, id, library, book } = fixture();
    const replacement = obfuscatedEpub(1);
    writeFileSync(path, replacement.data);
    expect(readBookArchive(id, library)).not.toBe(archive);
    expect(loadReader(id, "0", "/", library).sections).toHaveLength(1);
    expect(() => epubResource(readerRequest(), id, book.paths[1], library)).toThrow("资源不存在");
    rmSync(path); expect(() => readBookArchive(id, library)).toThrow("EPUB 不存在");
  });
  it("evicts by entry count and bytes, including parsed metadata growth", () => {
    const { path, root, book } = fixture(), second = root + "/second.epub";
    writeFileSync(second, book.data);
    const cache = new ReaderArchiveCache(1024 * 1024, 1), first = cache.get(path)!;
    cache.get(second); expect(cache.size).toBe(1); expect(cache.get(path)).not.toBe(first);
    const third = root + "/third.epub"; writeFileSync(third, book.data);
    const lru = new ReaderArchiveCache(1024 * 1024, 2), oldest = lru.get(path)!, recent = lru.get(second)!;
    lru.get(path); lru.get(third);
    expect(lru.get(path)).toBe(oldest); expect(lru.get(second)).not.toBe(recent);
    const bytes = new ReaderArchiveCache(first.weight + 1, 5), entry = bytes.get(path)!;
    expect(bytes.size).toBe(1); entry.metadata(); expect(bytes.size).toBe(0);
    expect(new ReaderArchiveCache(1, 5).get(path)).toBeDefined();
  });
});

// Timings are evidence, not machine-dependent pass/fail thresholds. Counters enforce
// the performance property even on contended CI hosts.
it("benchmarks a ~20 MB / 2241-member EPUB and guards indexed per-member work", async () => {
  const { library, id, cleanup } = readerFixture(); cleanups.push(cleanup);
  const book = obfuscatedEpub(2227, 9000, true), path = epubPath(library.base, id);
  writeFileSync(path, book.data);
  const request = readerRequest(contentUrl(id, book.paths[0]));
  const elapsed = async (work: () => unknown) => { const start = performance.now(); await work(); return performance.now() - start; };
  const legacyResource = () => {
    const [content] = loadEpubItem(readFileSync(path), book.paths[0], `/book/${id}/epub/`);
    return isolatedBookHtml(content, `/book/${id}/epub/`, request.url);
  };
  const legacyFirst = await elapsed(() => {
    bookEpubNeedsCssSync(readFileSync(path), library.loadMetadata(id), "");
    listEpubSections(readFileSync(path)); legacyResource();
  });
  const currentFirst = await elapsed(async () => { loadReader(id, "0", "/", library); await epubResource(request, id, book.paths[0], library).text(); });
  const archive = readBookArchive(id, library), before = { ...archive.stats };
  const legacy: number[] = [], current: number[] = [];
  for (let i = 0; i < 7; i++) {
    legacy.push(await elapsed(legacyResource));
    current.push(await elapsed(async () => { await epubResource(request, id, book.paths[0], library).text(); }));
  }
  expect(archive.members.size).toBe(2241);
  expect(archive.stats.metadataParses).toBe(1); expect(archive.stats.indexBuilds).toBe(1);
  expect(before.memberReads).toBe(4); // container, OPF, nav, requested chapter
  expect(archive.stats.memberReads - before.memberReads).toBe(7);
  expect(archive.stats.compressedBytesRead - before.compressedBytesRead).toBe(7 * archive.members.get(book.paths[0])!.compressedSize);
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const report = { archiveBytes: book.data.length, members: archive.members.size, chapters: book.paths.length, legacyFirstMs: legacyFirst, indexedFirstMs: currentFirst, legacyResourceMedianMs: median(legacy), indexedResourceMedianMs: median(current), coldMemberReads: before.memberReads, warmMemberReads: 1 };
  console.info("EPUB_PERFORMANCE", JSON.stringify(report));
  if (process.env.BINDERY_READER_PERF_REPORT) writeFileSync(process.env.BINDERY_READER_PERF_REPORT, JSON.stringify(report, null, 2));
}, 30000);
