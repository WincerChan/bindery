import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { rewriteCssUrls, stripCss } from "../src/core/css-strip";
import { stripEpubAssets } from "../src/core/epub-strip";
import { readArchive, writeArchive } from "../src/core/archive";
import { EpubArchive, extractCover, manifestFromOpf } from "../src/core/epub";
import { attr, descendants, parseXml } from "../src/core/xml";
import { applyTypesettingProfile } from "../src/client/kindle/epub";
import { defaultProfile, EMPTY_SETTINGS } from "../src/client/devices/profiles";
import { convertEpub } from "../src/client/boko/conversion";
import { parseKfxEntities, walkIon, type IonValue } from "../src/client/boko/kfx";
import { assetCover, assetEpub, assetFont } from "./support/kindle-assets";

const decoder = new TextDecoder();
const text = (archive: EpubArchive, path: string) => decoder.decode(archive.read(path));
describe("Kindle EPUB asset stripping", () => {
  it("defaults to a byte-identical copy, never mutates input and produces deterministic output", () => {
    const epub = assetEpub(), before = epub.slice();
    expect(stripEpubAssets(epub, {})).toEqual(epub);
    expect(applyTypesettingProfile(epub, defaultProfile())).toEqual(epub);
    const options = { stripFonts: true, stripImages: true };
    expect(stripEpubAssets(epub, options)).toEqual(stripEpubAssets(epub, options)); expect(epub).toEqual(before);
  });
  it("removes font rules / declarations in every CSS context, font files / manifest entries and only matching encryption entries", () => {
    const archive = new EpubArchive(stripEpubAssets(assetEpub(true), { stripFonts: true }));
    expect(archive.entries.some(entry => entry.name.includes("/Fonts/"))).toBe(false);
    const [opf, root] = archive.opf(); expect(manifestFromOpf(opf, root).some(item => /font|opentype/.test(item.media_type))).toBe(false);
    for (const entry of archive.entries.filter(entry => /css$|xhtml$/.test(entry.name))) expect(decoder.decode(entry.data)).not.toMatch(/font-family|@font-face/);
    expect(text(archive, "EPUB/Text/chapter.xhtml")).toContain("text-indent: 1em");
    const encryption = parseXml(archive.read("META-INF/encryption.xml")!);
    expect(descendants(encryption, "CipherReference").map(node => attr(node, "URI"))).toEqual(["EPUB/Images/art.png"]);
    const entries = readArchive(assetEpub(true)).map(entry => entry.name === "META-INF/encryption.xml" ? { ...entry, data: new TextEncoder().encode(decoder.decode(entry.data).replace("EPUB/Images/art.png", "EPUB/Fonts/obfuscated")) } : entry);
    expect(new EpubArchive(stripEpubAssets(writeArchive(entries), { stripFonts: true })).read("META-INF/encryption.xml")).toBeUndefined();
    expect(extractCover(stripEpubAssets(assetEpub(), { stripFonts: true }))?.[0]).toEqual(assetCover);
  });
  it("removes body images, image-only wrappers and backgrounds, retains captions and the SVG cover, and emits valid XHTML", () => {
    const archive = new EpubArchive(stripEpubAssets(assetEpub(), { stripImages: true })), [opf, root] = archive.opf();
    expect(archive.entries.filter(entry => entry.name.includes("/Images/")).map(entry => entry.name)).toEqual(["EPUB/Images/cover.png"]);
    expect(manifestFromOpf(opf, root).filter(item => item.media_type.startsWith("image/")).map(item => item.item_id)).toEqual(["cover"]);
    const chapter = parseXml(archive.read("EPUB/Text/chapter.xhtml")!);
    for (const tag of ["img", "image", "source", "picture", "svg"]) expect(descendants(chapter, tag)).toHaveLength(0);
    expect(descendants(chapter, "figure")).toHaveLength(1); expect(chapter.textContent).toContain("Keep this caption");
    expect(text(archive, "EPUB/Text/chapter.xhtml")).not.toContain("background:");
    expect(text(archive, "EPUB/Styles/book.css")).not.toContain("art.png");
    expect(descendants(parseXml(archive.read("EPUB/Text/cover.xhtml")!), "image")).toHaveLength(1);
    expect(extractCover(stripEpubAssets(assetEpub(), { stripImages: true }))?.[0]).toEqual(assetCover);
    for (const entry of archive.entries.filter(entry => /\.xhtml$/.test(entry.name))) {
      const errors: string[] = []; new DOMParser({ onError: (_level, message) => { errors.push(message); } }).parseFromString(decoder.decode(entry.data), "application/xhtml+xml"); expect(errors).toEqual([]);
    }
    expect(text(archive, "EPUB/Styles/book.css")).toContain("@font-face");
  });
  it("handles nested rules, comments, escapes, shorthand, data URLs and strings without damaging other CSS", () => {
    const css = String.raw`/* keep */ @media all { @FONT-FACE { src:url("font.woff"); } p { FONT-\66 amily: Publisher; color:red; content:"font-family: fake; }"; font:italic 12px Publisher; background:url("data:image/png;base64,abc"); mask: url(art\2e png); } }`;
    const result = stripCss(css, { stripFonts: true, stripImages: true, isImage: url => /^(?:data:image\/|art\.png)/.test(url) });
    expect(result).toBe('/* keep */ @media all { p { color:red; content:"font-family: fake; }"; } }');
    expect(stripCss('p { background: url( /* comment */ "art.png" ); color: red; }', { stripImages: true, isImage: url => url === "art.png" })).toBe('p { color: red; }');
    expect(rewriteCssUrls('@import "book.css"; @import url(book.css); p{content:"url(book.css)"}', url => url === "book.css" ? "cover.css" : undefined)).toBe('@import "cover.css"; @import url("cover.css"); p{content:"url(book.css)"}');
  });
  it("retains cover backgrounds only on cover pages, including transitive stylesheet imports", () => {
    const encode = (value: string) => new TextEncoder().encode(value);
    const entries = readArchive(assetEpub()).map(entry => {
      if (entry.name.endsWith("book.css")) return { ...entry, data: encode('@import "cover-assets.css"; p { color: black; }') };
      if (entry.name.endsWith("content.opf")) return { ...entry, data: encode(decoder.decode(entry.data).replace("</manifest>", '<item id="cover-css" href="Styles/cover-assets.css" media-type="text/css"/></manifest>')) };
      return entry;
    });
    entries.push({ name: "EPUB/Styles/cover-assets.css", data: encode('.art { background-image: url("../Images/cover.png"); }') });
    const archive = new EpubArchive(stripEpubAssets(writeArchive(entries), { stripImages: true })), [opf, root] = archive.opf();
    expect(text(archive, "EPUB/Styles/cover-assets.css")).not.toContain("cover.png");
    expect(text(archive, "EPUB/Text/chapter.xhtml")).toContain('href="../Styles/book.css"');
    const coverDoc = parseXml(archive.read("EPUB/Text/cover.xhtml")!);
    const link = descendants(coverDoc, "link")[0], path = `EPUB/Styles/${attr(link, "href").split("/").at(-1)}`;
    expect(path).not.toBe("EPUB/Styles/book.css");
    const imported = /@import "([^"]+)"/.exec(text(archive, path))![1];
    expect(text(archive, `EPUB/Styles/${imported}`)).toContain("../Images/cover.png");
    const manifestPaths = new Set(manifestFromOpf(opf, root).map(item => item.member_path));
    expect(manifestPaths.has(path)).toBe(true); expect(manifestPaths.has(`EPUB/Styles/${imported}`)).toBe(true);
  });
  it("keeps EPUB 3 cover metadata and picture covers while discarding non-cover source alternatives", () => {
    const encode = (value: string) => new TextEncoder().encode(value);
    const entries = readArchive(assetEpub()).map(entry => {
      if (entry.name.endsWith("content.opf")) return { ...entry, data: encode(decoder.decode(entry.data).replace('<meta name="cover" content="cover"/>', "")) };
      if (entry.name.endsWith("cover.xhtml")) return { ...entry, data: encode('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cover</title></head><body><picture><source srcset="../Images/cover.png 2x, ../Images/art.png 1x"/><img src="../Images/art.png"/></picture></body></html>') };
      return entry;
    });
    const copy = stripEpubAssets(writeArchive(entries), { stripImages: true }), archive = new EpubArchive(copy), doc = parseXml(archive.read("EPUB/Text/cover.xhtml")!);
    expect(extractCover(copy)?.[0]).toEqual(assetCover);
    expect(descendants(doc, "source")).toHaveLength(0); expect(descendants(doc, "img")).toHaveLength(1);
    expect(attr(descendants(doc, "img")[0], "src")).toBe("../Images/cover.png");
  });
});

it("vendored WASM emits no font resources / publisher family and only the cover image after stripping", async () => {
  const wasm = readFileSync(new URL("../vendor/boko/boko_bg.wasm", import.meta.url)), epub = assetEpub();
  const inspect = async (data: Uint8Array) => {
    const result = await convertEpub(data, wasm), entities = parseKfxEntities(result.data), values: IonValue[] = [];
    for (const entity of entities) walkIon(entity.value, value => { values.push(value); });
    return { entities, values, resources: entities.filter(entity => entity.type === 417 || entity.type === 418).map(entity => entity.value as Uint8Array) };
  };
  const before = await inspect(epub);
  expect(before.values).toContain("Publisher");
  expect(before.resources.some(bytes => Buffer.from(bytes).equals(assetFont))).toBe(true);
  expect(before.resources.length).toBeGreaterThan(2);
  const fonts = await inspect(stripEpubAssets(epub, { stripFonts: true }));
  expect(fonts.values).not.toContain("Publisher"); expect(fonts.resources.some(bytes => Buffer.from(bytes).equals(assetFont))).toBe(false);
  expect(fonts.entities.filter(entity => entity.type === 418)).toHaveLength(0);
  const images = await inspect(stripEpubAssets(epub, { stripImages: true }));
  expect(images.entities.filter(entity => entity.type === 417)).toHaveLength(1);
  expect(images.resources.filter(bytes => Buffer.from(bytes).equals(assetCover))).toHaveLength(1);
  const both = await inspect(stripEpubAssets(epub, { stripFonts: true, stripImages: true }));
  expect(both.resources).toHaveLength(1); expect(both.values).not.toContain("Publisher");
  const profile = { ...defaultProfile(), id: "custom", builtIn: false, settings: { ...EMPTY_SETTINGS, stripFonts: true, fontFamily: "Device Serif" } };
  expect((await inspect(applyTypesettingProfile(epub, profile))).values).toContain("Device Serif");
});
