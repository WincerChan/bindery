import { afterEach, expect, it, vi } from "vitest";
import { readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { readArchive, writeArchive } from "../src/core/archive";
import { guessMediaType } from "../src/core/epub";
import { encodeEpubPath } from "../src/core/epub-path";
import { stripEpubAssets } from "../src/core/epub-strip";
import { previewContentUrl } from "../src/features/kindle/typeset/model";
import { previewChapters } from "../src/features/kindle/typeset/preview.server";
import { kindlePreviewArchive, kindlePreviewResource } from "../src/server/kindle/preview";
import { ReaderArchiveCache, readerArchives } from "../src/server/reader/archive";
import { epubMemberResponse } from "../src/server/reader/resources";
import { readBookArchive } from "../src/server/reader/service";
import { epubPath } from "../src/server/storage";
import { obfuscatedEpub } from "./fixtures/reader/obfuscated";
import { readerFixture, readerRequest } from "./fixtures/reader/support";
import { assetEpub, coverStyleEpub } from "./support/kindle-assets";

const modes = ["00", "01", "10", "11"];
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); readerArchives.clear(); vi.restoreAllMocks(); });
function fixture(data: Uint8Array) {
  const fixture = readerFixture(); cleanups.push(fixture.cleanup);
  const file = epubPath(fixture.library.base, fixture.id); writeFileSync(file, data);
  const prefix = (mode: string) => `/devices/content/${fixture.id}/${mode}/epub/`;
  const get = (path: string, mode: string, method = "GET") => {
    const url = prefix(mode) + encodeEpubPath(path);
    // Match the router contract: exactly one decode before invoking the service.
    const raw = decodeURIComponent(new URL(url, "http://localhost").pathname.slice(prefix(mode).length));
    return kindlePreviewResource(readerRequest(url, { method }), fixture.id, mode, raw, fixture.library);
  };
  return { ...fixture, file, prefix, get, archive: readBookArchive(fixture.id, fixture.library) };
}

it.each(modes)("serves obfuscated preview paths, CSS, fonts, images and footnotes in mode %s", async mode => {
  const book = obfuscatedEpub(), { id, library, file, prefix, get, archive } = fixture(book.data);
  const options = { stripFonts: mode[0] === "1", stripImages: mode[1] === "1" };
  expect(previewChapters(library, id)).toEqual(book.paths.map((item_path, i) => ({ item_path, title: `第 ${i} 章` })));
  const url = (path: string) => "http://localhost" + prefix(mode) + encodeEpubPath(path);
  const frame = previewContentUrl(id, book.paths[0], options), parsed = new URL(frame, "http://localhost");
  expect(parsed.search).toBe(""); expect(parsed.hash).toBe("");
  expect(frame).toContain(encodeEpubPath(book.paths[0]));
  for (const token of ["%3A", "%7C", "%2A", "%7E", "%23", "%3F", "%25"]) expect(frame).toContain(token);
  const response = get(book.paths[0], mode), html = await response.text();
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("Content-Length")).toBe(String(Buffer.byteLength(html)));
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  const csp = response.headers.get("Content-Security-Policy")!;
  for (const policy of ["sandbox allow-same-origin", "script-src 'none'", "connect-src 'none'", "frame-ancestors 'self'"]) expect(csp).toContain(policy);
  expect(csp).not.toContain("allow-scripts");
  expect(html).toContain(url(book.css)); expect(html).toContain(url(book.paths[1]) + "#note");
  expect(html).toContain(url(book.paths[0]) + "#note");
  expect(html).not.toMatch(/<script|<form|<input|parent\.attack/);
  const css = await get(book.css, mode).text(), imported = await get(book.importedCss, mode).text();
  expect(css).toContain(url(book.importedCss));
  if (options.stripImages) {
    expect(html).not.toContain("<img"); expect(css).not.toContain("background"); expect(imported).not.toContain("background");
    expect(() => get(book.image, mode)).toThrow("资源不存在");
  } else {
    expect(html).toContain(url(book.image)); expect(css).toContain(url(book.image)); expect(imported).toContain(url(book.image));
    expect(new Uint8Array(await get(book.image, mode).arrayBuffer())).toEqual(new Uint8Array(archive.read(book.image)!));
  }
  if (options.stripFonts) {
    expect(css).not.toMatch(/@font-face|font-family/); expect(() => get(book.font, mode)).toThrow("资源不存在");
  } else {
    expect(css).toContain("@font-face"); expect(css).toContain(url(book.font));
    expect(new Uint8Array(await get(book.font, mode).arrayBuffer())).toEqual(new Uint8Array(archive.read(book.font)!));
  }
  for (const name of ["%2e%2e", "%2F", "#", "?", "a:b", "::|"]) expect(await get(`OEBPS/Images/${name}`, mode).text()).toBe(name);
  const head = get(book.paths[0], mode, "HEAD"); expect(await head.text()).toBe("");
  expect(head.headers.get("Content-Length")).toBe(response.headers.get("Content-Length"));
  for (const path of ["../package.opf", "/OEBPS/package.opf", "a/../OEBPS/package.opf", "OEBPS//package.opf", "a\\b", "a\0b", "a\nb", book.paths[0].split("/").at(-1)!, "OEBPS/Images/%252F"]) {
    expect(() => kindlePreviewResource(readerRequest(), id, mode, path, library)).toThrow("资源不存在");
  }
  expect(readFileSync(file)).toEqual(Buffer.from(book.data)); expect(library.db.getReaderProgress(id)).toBeNull();
});

for (const [label, data] of [["obfuscated", () => obfuscatedEpub().data], ["assets/encryption", () => assetEpub(true)], ["transitive cover styles", coverStyleEpub]] as const) {
  it.each(modes)(`matches every whole-copy member before HTTP isolation (${label}, mode %s)`, async mode => {
    const original = data(), { archive, get, prefix } = fixture(original);
    const expected = new Map(readArchive(stripEpubAssets(original, { stripFonts: mode[0] === "1", stripImages: mode[1] === "1" })).map(entry => [entry.name, entry.data]));
    const plan = kindlePreviewArchive(archive, mode);
    for (const name of new Set([...archive.members.keys(), ...expected.keys()])) {
      const member = expected.get(name), transformed = plan.read(name);
      expect(transformed && new Uint8Array(transformed), name).toEqual(member);
      if (!member) { expect(() => get(name, mode), name).toThrow("资源不存在"); continue; }
      // Verify the actual endpoint adds only the shared reader URL/security rendering.
      const media = guessMediaType(name) === "application/octet-stream" ? plan.mediaType(name) || "application/octet-stream" : guessMediaType(name);
      const rendered = epubMemberResponse(readerRequest(prefix(mode) + encodeEpubPath(name)), prefix(mode), name, plan, member, media, { "Cache-Control": "no-store" });
      const response = get(name, mode);
      expect(new Uint8Array(await response.arrayBuffer()), name).toEqual(new Uint8Array(await rendered.arrayBuffer()));
      expect([...response.headers], name).toEqual([...rendered.headers]);
    }
  });
}

it.each(modes)("reuses one plan/index and reads only the target member on warm requests in mode %s", async mode => {
  const book = obfuscatedEpub(), { archive, get, library, id } = fixture(book.data);
  const opf = vi.spyOn(archive, "opf"), read = vi.spyOn(archive, "read");
  const plan = kindlePreviewArchive(archive, mode);
  expect(read.mock.calls.map(args => args[0])).toEqual(["META-INF/container.xml", "OEBPS/package.opf"]);
  read.mockClear(); const initial = { ...archive.stats };
  for (let i = 0; i < 5; i++) {
    await get(book.paths[i % book.paths.length], mode).text(); await get(book.css, mode).text();
    expect(kindlePreviewArchive(readBookArchive(id, library), mode)).toBe(plan);
  }
  expect(opf).toHaveBeenCalledTimes(1); expect(archive.stats.indexBuilds).toBe(1);
  expect(read).toHaveBeenCalledTimes(10);
  expect(archive.stats.memberReads - initial.memberReads).toBe(10);
  expect(archive.stats.compressedBytesRead - initial.compressedBytesRead).toBe(read.mock.calls.reduce((sum, [name]) => sum + archive.members.get(name)!.compressedSize, 0));
});

it("serves generated cover CSS directly, builds the dependency map once and reads one stylesheet per later request", async () => {
  const { archive, get } = fixture(coverStyleEpub()), read = vi.spyOn(archive, "read");
  const generated = "EPUB/Styles/bindery-kindle-cover-2.css";
  // An initial direct CSS request is valid even before the cover document is fetched.
  expect(await get(generated, "11").text()).toContain("bindery-kindle-cover-1.css");
  const weight = archive.weight; read.mockClear();
  for (let i = 0; i < 3; i++) {
    expect(await get("EPUB/Text/cover.xhtml", "11").text()).toContain("bindery-kindle-cover-2.css");
    expect(await get(generated, "11").text()).toContain("bindery-kindle-cover-1.css");
  }
  expect(archive.weight).toBe(weight);
  expect(read.mock.calls.map(args => args[0])).toEqual(Array.from({ length: 3 }, () => ["EPUB/Text/cover.xhtml", "EPUB/Styles/book.css"]).flat());
  expect(() => get("EPUB/Styles/bindery-kindle-cover-9999.css", "11")).toThrow("资源不存在");
});

it("charges plan metadata to the reader LRU and invalidates plans on replacement or deletion", async () => {
  const book = obfuscatedEpub(), { archive, file, get, id, library } = fixture(book.data);
  const cache = new ReaderArchiveCache(archive.weight + 1), indexed = cache.get(file)!;
  kindlePreviewArchive(indexed, "11"); expect(cache.size).toBe(0);
  const first = kindlePreviewArchive(archive, "11");
  const stat = statSync(file); utimesSync(file, stat.atime, new Date(stat.mtimeMs + 2000));
  expect(kindlePreviewArchive(readBookArchive(id, library), "11")).not.toBe(first);
  const replacement = obfuscatedEpub(1); writeFileSync(file, replacement.data);
  expect(await get(replacement.paths[0], "11").text()).toContain("needle");
  expect(() => get(book.paths[1], "11")).toThrow("资源不存在");
  rmSync(file); expect(() => get(book.paths[0], "11")).toThrow("EPUB 不存在");
});

it("retries cover dependency discovery after a member read fails without caching partial state", async () => {
  const { archive, get } = fixture(coverStyleEpub());
  kindlePreviewArchive(archive, "11");
  const read = archive.read.bind(archive); let fail = true;
  vi.spyOn(archive, "read").mockImplementation(name => {
    if (name === "EPUB/Styles/book.css" && fail) { fail = false; throw new Error("member read failed"); }
    return read(name);
  });
  const generated = "EPUB/Styles/bindery-kindle-cover-2.css";
  expect(() => get(generated, "11")).toThrow("member read failed");
  expect(await get(generated, "11").text()).toContain("bindery-kindle-cover-1.css");
  expect(await get("EPUB/Text/cover.xhtml", "11").text()).toContain("bindery-kindle-cover-2.css");
});

it("does not resolve unsafe stored member names through aliases", () => {
  const book = obfuscatedEpub();
  const data = writeArchive([...book.entries, { name: "../escape.xhtml", data: new TextEncoder().encode("escape") }]);
  const { get } = fixture(data);
  expect(() => get("../escape.xhtml", "11")).toThrow("资源不存在");
  expect(() => get("escape.xhtml", "11")).toThrow("资源不存在");
});
