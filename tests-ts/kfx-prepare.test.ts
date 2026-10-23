import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { convertEpub } from "../src/client/boko/conversion";
import { ionField, parseKfxEntities, type IonValue } from "../src/client/boko/kfx";
import { readArchive, writeArchive } from "../src/core/archive";
import { prepareEpubForBoko } from "../src/core/kfx-prepare";
import { assetCover } from "./support/kindle-assets";

const wasm = readFileSync(new URL("../vendor/boko/boko_bg.wasm", import.meta.url));
const encoder = new TextEncoder(), decoder = new TextDecoder();
// The cover page Calibre writes (seen in 《规训与惩罚》, which hangs a KO3 on firmware 5.18.1).
const calibreTitlepage = `<?xml version='1.0' encoding='utf-8'?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh">
    <head><title>Cover</title></head>
    <body>
        <div>
            <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="100%" height="100%" viewBox="0 0 292 425" preserveAspectRatio="none">
                <image width="292" height="425" xlink:href="../Images/cover.png"/>
            </svg>
        </div>
</body>
</html>`;
const chapter = (body: string) => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>正文</title></head><body>${body}</body></html>`;
function calibreEpub(titlepage = calibreTitlepage, body = "<h1>第一章</h1><p>正文第一段。</p>") {
  const opf = `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:bindery-svg-cover</dc:identifier><dc:title>SVG 封面</dc:title><dc:language>zh</dc:language><meta name="cover" content="cover"/></metadata><manifest><item id="cover" href="Images/cover.png" media-type="image/png"/><item id="titlepage" href="Text/titlepage.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="Text/c1.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="titlepage"/><itemref idref="c1"/></spine><guide><reference type="cover" title="Cover" href="Text/titlepage.xhtml"/></guide></package>`;
  const ncx = `<?xml version="1.0" encoding="utf-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:bindery-svg-cover"/></head><docTitle><text>SVG 封面</text></docTitle><navMap><navPoint id="n1" playOrder="1"><navLabel><text>第一章</text></navLabel><content src="Text/c1.xhtml"/></navPoint></navMap></ncx>`;
  return writeArchive([
    { name: "mimetype", data: encoder.encode("application/epub+zip") },
    { name: "META-INF/container.xml", data: encoder.encode(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`) },
    { name: "OEBPS/content.opf", data: encoder.encode(opf) },
    { name: "OEBPS/toc.ncx", data: encoder.encode(ncx) },
    { name: "OEBPS/Images/cover.png", data: assetCover },
    { name: "OEBPS/Text/titlepage.xhtml", data: encoder.encode(titlepage) },
    { name: "OEBPS/Text/c1.xhtml", data: encoder.encode(chapter(body)) },
  ]);
}
const member = (data: Uint8Array, name: string) => decoder.decode(readArchive(data).find(entry => entry.name === name)!.data);
/** Sections whose storyline holds neither text nor a resource: what boko made of the SVG cover page. */
function emptySections(kfx: Uint8Array) {
  const entities = parseKfxEntities(kfx), symbol = (value: IonValue) => (value as { symbol: number }).symbol;
  const stories = new Map(entities.filter(e => e.type === 259).map(e => [symbol(ionField(e.value, 176)), e.value]));
  const drawn = (node: IonValue): boolean => ionField(node, 145) !== null || ionField(node, 175) !== null || ((ionField(node, 146) as IonValue[] | null) ?? []).some(drawn);
  return entities.filter(e => e.type === 260).filter(e => ((ionField(e.value, 141) as IonValue[] | null) ?? []).some(page => {
    const story = stories.get(symbol(ionField(page, 176)));
    return !((ionField(story ?? null, 146) as IonValue[] | null) ?? []).some(drawn);
  })).length;
}

describe("EPUB preparation for boko", () => {
  it("rewrites an SVG that only wraps one image to an img with the same source", () => {
    const prepared = prepareEpubForBoko(calibreEpub()), page = member(prepared, "OEBPS/Text/titlepage.xhtml");
    expect(page).not.toMatch(/<svg\b/);
    expect(page).toMatch(/<img [^>]*src="\.\.\/Images\/cover\.png"/);
    expect(member(prepared, "OEBPS/Text/c1.xhtml")).toBe(chapter("<h1>第一章</h1><p>正文第一段。</p>"));
  });
  it("removes the empty KFX section boko produced for the SVG cover page", async () => {
    const book = calibreEpub();
    const raw = new Uint8Array(await import("../vendor/boko/boko.js").then(async boko => { await boko.default({ module_or_path: wasm }); return boko.convert(book, "epub", "kfx"); }));
    expect(emptySections(raw)).toBe(1);
    const converted = await convertEpub(book, wasm);
    expect(emptySections(converted.data)).toBe(0);
    expect(parseKfxEntities(converted.data).filter(e => e.type === 417)).toHaveLength(1);
  });
  it("leaves SVG that draws anything besides one image untouched", () => {
    const drawing = calibreTitlepage.replace("</svg>", `<text x="10" y="20">书名</text></svg>`), book = calibreEpub(drawing);
    expect(prepareEpubForBoko(book)).toBe(book);
  });
  it("returns the original bytes when there is no inline SVG or the document is not well-formed", () => {
    const plain = calibreEpub(chapter("<p>封面</p>"));
    expect(prepareEpubForBoko(plain)).toBe(plain);
    const broken = calibreEpub(calibreTitlepage.replace("</div>", "</span>"));
    expect(prepareEpubForBoko(broken)).toBe(broken);
  });
});
