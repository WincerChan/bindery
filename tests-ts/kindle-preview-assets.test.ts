import { afterEach, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { kindlePreviewResource } from "../src/server/kindle/preview";
import { previewContentUrl } from "../src/features/kindle/typeset/model";
import { epubPath } from "../src/server/storage";
import { readerFixture } from "./fixtures/reader/support";
import { assetCover, assetEpub } from "./support/kindle-assets";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); });
it("serves the transformed preview document and CSS, retains the cover, isolates URLs and leaves the library unchanged", async () => {
  const fixture = readerFixture(); cleanups.push(fixture.cleanup);
  const path = epubPath(fixture.library.base, fixture.id), original = assetEpub(); writeFileSync(path, original);
  const get = (item: string, mode = "11", method = "GET") => {
    const url = `http://localhost/kindle/content/${fixture.id}/${mode}/epub/${item}`;
    return kindlePreviewResource(new Request(url, { method }), fixture.id, mode, item, fixture.library);
  };
  const chapter = get("EPUB/Text/chapter.xhtml"), html = await chapter.text();
  expect(chapter.headers.get("Content-Security-Policy")).toContain("connect-src 'none'");
  expect(chapter.headers.get("Cache-Control")).toBe("no-store");
  expect(html).not.toMatch(/font-family|@font-face|<img|<image|<picture|<svg|background:/);
  expect(html).toContain("Text survives &amp; stays valid");
  expect(html).toContain(`/kindle/content/${fixture.id}/11/epub/EPUB/Styles/book.css`);
  expect(await get("EPUB/Styles/book.css").text()).not.toMatch(/font-family|@font-face|art.png/);
  expect(await get("EPUB/Text/cover.xhtml").text()).toContain("<image");
  expect(new Uint8Array(await get("EPUB/Images/cover.png").arrayBuffer())).toEqual(assetCover);
  expect(() => get("EPUB/Images/art.png")).toThrow("资源不存在");
  expect(() => get("EPUB/Fonts/book.ttf")).toThrow("资源不存在");
  expect(await get("EPUB/Text/chapter.xhtml", "01").text()).toContain("font-family");
  expect(await get("EPUB/Text/chapter.xhtml", "10").text()).toContain("<img");
  expect(await get("EPUB/Text/chapter.xhtml", "11", "HEAD").text()).toBe("");
  expect(() => get("EPUB/Text/chapter.xhtml", "bad")).toThrow("资源不存在");
  expect(() => get("../content.opf")).toThrow("资源不存在");
  expect(readFileSync(path)).toEqual(Buffer.from(original)); expect(fixture.library.db.getReaderProgress(fixture.id)).toBeNull();
});

it("encodes preview member URLs with stable asset modes and preserves the original URL when disabled", () => {
  expect(previewContentUrl("book", "Text/第 一.xhtml", {})).toBe("/book/book/epub/Text/%E7%AC%AC%20%E4%B8%80.xhtml");
  expect(previewContentUrl("book", "Text/ch.xhtml", { stripFonts: true })).toBe("/kindle/content/book/10/epub/Text/ch.xhtml");
});
