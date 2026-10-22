import { describe, expect, it } from "vitest";
import { readArchive, writeArchive } from "../src/core/archive";
import { rewriteCssUrls } from "../src/core/css-strip";
import { resolveEpubReference } from "../src/core/epub-path";
import { sanitizeEpubMemberPaths } from "../src/core/epub-safe-paths";
import { convertToKepub, kepubEntryBytes, readKepubZip } from "../src/core/kepub";
import { obfuscatedEpub } from "./fixtures/reader/obfuscated";

const unsafe = /[\\:*?"<>|#%\p{Cc}]/u;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const encode = (value: string) => new TextEncoder().encode(value);
const decodeAttribute = (value: string) => value.replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code: string) => String.fromCodePoint(Number(code.startsWith("x") ? `0${code}` : code)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

/** Every local link in package, navigation, chapter and stylesheet members must name an existing member. */
function brokenReferences(members: { name: string; data: Uint8Array }[]): string[] {
  const names = new Set(members.map(member => member.name)), broken: string[] = [];
  const check = (from: string, raw: string) => {
    if (!raw || raw.startsWith("#") || /^[a-z][\w+.-]*:/i.test(raw)) return;
    if (!resolveEpubReference(from.startsWith("META-INF/") ? "" : from, raw, path => names.has(path))) broken.push(`${from} -> ${raw}`);
  };
  for (const { name, data } of members) {
    if (!/\.(?:opf|ncx|xhtml|css|xml)$/.test(name)) continue;
    const source = text(data);
    for (const [, url] of decodeAttribute(source).matchAll(/url\(\s*["']?([^"')]+)/g)) check(name, url);
    for (const [, url] of source.matchAll(/@import\s+["']([^"']+)/g)) check(name, url);
    if (!name.endsWith(".css")) for (const [, , url] of source.matchAll(/\s(href|src|full-path)="([^"]*)"/g)) check(name, decodeAttribute(url));
  }
  return broken;
}

describe("Kobo-safe EPUB member paths", () => {
  it("leaves archives with ordinary names byte-identical", () => {
    const data = writeArchive([
      { name: "mimetype", data: encode("application/epub+zip") },
      { name: "META-INF/container.xml", data: encode('<container><rootfiles><rootfile full-path="OEBPS/书.opf"/></rootfiles></container>') },
      { name: "OEBPS/书.opf", data: encode('<package><manifest><item href="正文 一.xhtml"/></manifest></package>') },
      { name: "OEBPS/正文 一.xhtml", data: encode("<html/>") },
    ]);
    const result = sanitizeEpubMemberPaths(data);
    expect(result.changed).toBe(false);
    expect(result.data).toBe(data);
  });

  it("renames FAT-invalid members and rewrites every reference to them", () => {
    const book = obfuscatedEpub(4);
    expect(brokenReferences(book.entries)).toEqual([]);
    const result = sanitizeEpubMemberPaths(book.data), members = readArchive(result.data);
    expect(result.changed).toBe(true);
    expect(members[0]).toMatchObject({ name: "mimetype" });
    expect(members.map(member => member.name).filter(name => unsafe.test(name))).toEqual([]);
    expect(members).toHaveLength(book.entries.length);
    expect(brokenReferences(members)).toEqual([]);
    // Directory depth is preserved, so untouched relative links between members keep working.
    expect(members.map(member => member.name.split("/").length)).toEqual(book.entries.map(entry => entry.name.split("/").length));
    const chapter = text(members.find(member => member.name.endsWith(".xhtml") && member.name.startsWith("OEBPS/Text/"))!.data);
    expect(chapter).toContain("needle 第 0 章");
    expect(chapter).toMatch(/<a href="f\d+\.xhtml#note">下章<\/a>/);
    expect(chapter).toContain('<a href="#note">脚注</a>');
    expect(chapter).toMatch(/style="background:url\(&quot;\.\.\/\.\.\/\.\.\/Images\/d\d+\/f\d+\.png&quot;\)"/);
  });

  it("produces a KEPUB whose members and links stay valid", () => {
    // kepubify requires the OCF version and rootfile media type; the shared fixture omits them.
    const book = obfuscatedEpub(3), entries = book.entries.map(entry => entry.name === "META-INF/container.xml" ? { ...entry, data: encode(text(entry.data).replace("<container ", '<container version="1.0" ').replace("<rootfile ", '<rootfile media-type="application/oebps-package+xml" ')) } : entry);
    const kepub = convertToKepub(sanitizeEpubMemberPaths(writeArchive(entries)).data);
    const members = readKepubZip(kepub.data).map(entry => ({ name: entry.name, data: kepubEntryBytes(entry) }));
    expect(members.map(member => member.name).filter(name => unsafe.test(name))).toEqual([]);
    expect(brokenReferences(members)).toEqual([]);
    expect(text(members.find(member => member.name.endsWith(".xhtml") && member.name.startsWith("OEBPS/Text/"))!.data)).toContain('class="koboSpan"');
  });

  it("rewrites the package path in container.xml when the OPF itself is renamed", () => {
    const data = writeArchive([
      { name: "mimetype", data: encode("application/epub+zip") },
      { name: "META-INF/container.xml", data: encode('<container><rootfiles><rootfile full-path="OPS/a:b.opf"/></rootfiles></container>') },
      { name: "OPS/a:b.opf", data: encode('<package><manifest><item href="c%7Cd.xhtml"/></manifest><guide><reference href="c|d.xhtml#top"/></guide></package>') },
      { name: "OPS/c|d.xhtml", data: encode("<html/>") },
    ]);
    const members = readArchive(sanitizeEpubMemberPaths(data).data);
    expect(members.map(member => member.name)).toEqual(["mimetype", "META-INF/container.xml", "OPS/f1.opf", "OPS/f2.xhtml"]);
    expect(text(members[1].data)).toContain('full-path="OPS/f1.opf"');
    expect(text(members[2].data)).toBe('<package><manifest><item href="f2.xhtml"/></manifest><guide><reference href="f2.xhtml#top"/></guide></package>');
  });

  it("reads an unquoted url() containing a comment opener as one URL", () => {
    expect(rewriteCssUrls("@import url(../a/**:|*.css); p{color:red}", url => url === "../a/**:|*.css" ? "b.css" : undefined)).toBe('@import url("b.css"); p{color:red}');
    expect(rewriteCssUrls("p{background:url( a.png )}", url => url === "a.png" ? "c.png" : undefined)).toBe('p{background:url("c.png")}');
  });
});
