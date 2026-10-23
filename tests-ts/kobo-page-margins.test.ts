import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readArchive, writeArchive } from "../src/core/archive";
import { stripCss } from "../src/core/css-strip";
import { stripEpubAssets } from "../src/core/epub-strip";
import { convertToKepubAsync, kepubEntryBytes, readKepubZip } from "../src/core/kepub";
import { convertForKobo } from "../src/core/kobo-kepub";

const margins = (css: string, pageRoot = false) => stripCss(css, { stripPageMargins: true, pageRoot, isImage: () => false });
const encode = (value: string) => new TextEncoder().encode(value);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("stripping a book's own page margins", () => {
  it("drops non-zero margin and padding only on rules for the page itself", () => {
    expect(margins("html, body { height: 95%; padding: 0.5em; }")).toBe("html, body { height: 95%; }");
    expect(margins(":root{margin:0 5%} BODY { margin-left: 2em; padding-inline-start: 1em; color: red }")).toBe(":root{} BODY { color: red }");
    expect(margins("@media screen { body { margin: 1em } }")).toBe("@media screen { body {} }");
    // Special pages and descendants keep their layout.
    const kept = "body.introduction { padding: 25% 10%; } body p { margin: 1em; } p { margin: 0.8em 0 0 0; } html > body { padding: 1em }";
    expect(margins(kept)).toBe(kept);
  });

  it("keeps explicit zeros so the renderer's default body margin does not come back", () => {
    expect(margins("body { padding: 0; margin-left: 0px; margin-right: 0 !important; margin-top: 1em; }")).toBe("body { padding: 0; margin-left: 0px; margin-right: 0 !important; }");
  });

  it("treats an html or body inline style as the page root", () => {
    expect(margins("margin: 3em; color: red", true)).toBe(" color: red");
    expect(margins("margin: 3em; color: red")).toBe("margin: 3em; color: red");
  });

  it("rewrites only stylesheets, <style> blocks and html/body style attributes in the EPUB", () => {
    const entries = [
      { name: "mimetype", data: encode("application/epub+zip") },
      { name: "META-INF/container.xml", data: encode('<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>') },
      { name: "OEBPS/content.opf", data: encode('<package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata/><manifest><item id="css" href="style.css" media-type="text/css"/><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>') },
      { name: "OEBPS/style.css", data: encode("html, body { padding: 0.5em; } p { margin: 1em 0; }") },
      { name: "OEBPS/a.xhtml", data: encode('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><style>body{margin:2em}</style></head><body style="padding: 1em; color: red"><p style="margin: 3em">正文</p></body></html>') },
      { name: "OEBPS/b.xhtml", data: encode('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body class="cover"><p>封面</p></body></html>') },
    ];
    const output = new Map(readArchive(stripEpubAssets(writeArchive(entries), { stripPageMargins: true })).map(entry => [entry.name, decode(entry.data)]));
    expect(output.get("OEBPS/style.css")).toBe("html, body { } p { margin: 1em 0; }");
    expect(output.get("OEBPS/a.xhtml")).toBe('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><style>body{}</style></head><body style=" color: red"><p style="margin: 3em">正文</p></body></html>');
    expect(output.get("OEBPS/b.xhtml")).toBe(decode(entries[5].data));
  });
});

describe("Kobo conversion pipeline", () => {
  const fixture = new Uint8Array(readFileSync(new URL("./fixtures/parity/kepub/input-mixed.epub", import.meta.url)));
  const members = (data: Uint8Array) => readKepubZip(data).map(entry => [entry.name, decode(kepubEntryBytes(entry))]);

  it("hands a plain EPUB to the converter untouched", async () => {
    expect((await convertForKobo(fixture)).data).toEqual((await convertToKepubAsync(fixture)).data);
  });

  it("strips page margins in the same KEPUB and compresses the intermediate archive once", async () => {
    const plain = await convertForKobo(fixture), stripped = await convertForKobo(fixture, { stripPageMargins: true });
    expect(readKepubZip(stripped.data).filter(entry => entry.name !== "mimetype" && entry.method === 0 && entry.uncompressedSize > 0)).toEqual([]);
    expect(members(stripped.data).map(([name]) => name)).toEqual(members(plain.data).map(([name]) => name));
    expect(stripped.data.byteLength).toBeLessThan(plain.data.byteLength * 1.05);
  });
});
