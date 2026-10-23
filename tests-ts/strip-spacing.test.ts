import { describe, expect, it } from "vitest";
import { readArchive, writeArchive } from "../src/core/archive";
import { stripCss } from "../src/core/css-strip";
import { stripEpubAssets } from "../src/core/epub-strip";

const lineHeight = (css: string) => stripCss(css, { stripLineHeight: true, isImage: () => false });
const spacing = (css: string) => stripCss(css, { stripParagraphSpacing: true, isImage: () => false });
const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

describe("line-height stripping", () => {
  it("removes line-height declarations and only the line-height part of a font shorthand", () => {
    expect(lineHeight("p { line-height: 1.5; color: red; }")).toBe("p { color: red; }");
    expect(lineHeight("p { color: red; line-height: normal !important; }")).toBe("p { color: red; }");
    expect(lineHeight("p { font: bold 1em/1.6 serif; }")).toBe("p { font: bold 1em serif; }");
    expect(lineHeight("p { font: italic 12px / 1.6 'Book Serif', serif; }")).toBe("p { font: italic 12px 'Book Serif', serif; }");
    expect(lineHeight("p { font: 12px/calc(1em + 2px) serif; }")).toBe("p { font: 12px serif; }");
  });
  it("leaves comments, strings and unrelated declarations untouched", () => {
    expect(lineHeight("/* line-height: 2 */ p { color: red; content: \"line-height: 3\"; }")).toBe("/* line-height: 2 */ p { color: red; content: \"line-height: 3\"; }");
    expect(lineHeight("p { line-height: 2; }")).not.toContain("line-height");
    expect(stripCss("p { line-height: 2; }", { isImage: () => false })).toBe("p { line-height: 2; }");
  });
});

describe("paragraph-spacing stripping", () => {
  it("keeps only the horizontal values of every margin shorthand arity", () => {
    expect(spacing("p { margin: 1em 2em; }")).toBe("p { margin-left: 2em; margin-right: 2em; }");
    expect(spacing("p { margin: 0; }")).toBe("p { margin-left: 0; margin-right: 0; }");
    expect(spacing("p { margin: 1em 2em 3em; }")).toBe("p { margin-left: 2em; margin-right: 2em; }");
    expect(spacing("p { margin: 1em 2em 3em 4em; }")).toBe("p { margin-left: 4em; margin-right: 2em; }");
    expect(spacing("p { margin: 1em 2em !important; }")).toBe("p { margin-left: 2em !important; margin-right: 2em !important; }");
    expect(spacing("p { margin: calc(1em + 2px) auto; }")).toBe("p { margin-left: auto; margin-right: auto; }");
  });
  it("removes vertical margin properties but keeps padding and horizontal margins", () => {
    expect(spacing("p { margin-top: 1em; margin-bottom: 2em; margin-block: 3em; margin-block-start: 4em; margin-block-end: 5em; margin-left: 6em; padding: 7em; }")).toBe("p { margin-left: 6em; padding: 7em; }");
  });
  it("keeps heading rules, including a mixed selector list", () => {
    for (const css of ["h1 { margin: 1em 0; }", "h3.title { margin-top: 1em; }", ".chapter h1 { margin-block: 1em; }", "p, h1 { margin: 1em 0; }"]) expect(spacing(css)).toBe(css);
    expect(spacing("p.h1 { margin-top: 1em; }")).toBe("p.h1 { }");
    expect(spacing("p[title=\"h1\"] { margin-top: 1em; }")).toBe("p[title=\"h1\"] { }");
  });
  it("keeps inline heading styles but strips other inline styles", () => {
    expect(stripCss("margin: 1em 2em", { stripParagraphSpacing: true, heading: true, isImage: () => false })).toBe("margin: 1em 2em");
    expect(stripCss("margin: 1em 2em", { stripParagraphSpacing: true, isImage: () => false })).toBe("margin-left: 2em; margin-right: 2em");
  });
});

describe("stripping the book's own line height and paragraph spacing", () => {
  it("rewrites stylesheets, <style> blocks and inline styles, keeping inline heading margins", () => {
    const entries = [
      { name: "mimetype", data: encode("application/epub+zip") },
      { name: "META-INF/container.xml", data: encode('<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>') },
      { name: "OEBPS/content.opf", data: encode('<package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata/><manifest><item id="css" href="style.css" media-type="text/css"/><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>') },
      { name: "OEBPS/style.css", data: encode("p { line-height: 1.8; margin: 1em 0; } h2 { line-height: 1.4; margin: 1em 0; }") },
      { name: "OEBPS/a.xhtml", data: encode('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><style>p{line-height:2;margin-top:3em}</style></head><body><p style="line-height: 2; margin: 1em 2em">正文</p><h2 style="line-height:1.5; margin-top: 1em">标题</h2></body></html>') },
    ];
    const output = new Map(readArchive(stripEpubAssets(writeArchive(entries), { stripLineHeight: true, stripParagraphSpacing: true })).map(entry => [entry.name, decode(entry.data)]));
    expect(output.get("OEBPS/style.css")).toBe("p { margin-left: 0; margin-right: 0; } h2 { margin: 1em 0; }");
    expect(output.get("OEBPS/a.xhtml")).toBe('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><style>p{}</style></head><body><p style=" margin-left: 2em; margin-right: 2em">正文</p><h2 style=" margin-top: 1em">标题</h2></body></html>');
  });
});
