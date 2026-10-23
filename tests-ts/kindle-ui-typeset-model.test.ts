import { afterEach, expect, it, vi } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { inspectFontBatch } from "../src/features/kindle/typeset/model";
import { previewAnchorPage, previewPagination, screenFor } from "../src/features/devices/preview/model";
import { DocumentFonts, PreviewDocument } from "../src/features/devices/preview/frame";
import { previewChapters, previewData } from "../src/features/devices/preview/preview.server";
import { listFonts } from "../src/client/kindle/fonts";
import { pairDevice } from "../src/client/kindle/identity";
import { epubPath } from "../src/server/storage";
import { readerFixture } from "./fixtures/reader/support";
import { fakeKindle } from "./support/fake-fs";
import { defaultReadingSettings, marginXPx, pageGeometry, previewTarget } from "../src/client/devices/typeset";
import { previewDocumentFixture } from "./support/kindle-preview-dom";
const kindleGeometry = (model: string, preset = "narrow") => pageGeometry(previewTarget("kindle", model), { ...defaultReadingSettings("kindle"), margin: preset });
const koboGeometry = (model = "libra2") => pageGeometry(previewTarget("kobo", model), defaultReadingSettings("kobo"));
import { fire } from "./support/client-dom";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });
const font = (name: string) => new File([new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])], name);
function fontDocument() {
  const fonts = new Set<FontFace>(), styles: Array<{ textContent: string; dataset: object; remove: ReturnType<typeof vi.fn> }> = [];
  const document = { fonts, createElement: () => { const style = { textContent: "", dataset: {}, setAttribute: vi.fn(), remove: vi.fn() }; styles.push(style); return style; }, head: { append: vi.fn(), insertBefore: vi.fn() }, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as Document;
  return { document, fonts, styles };
}
async function fontDevice() {
  const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "测试设备");
  for (const name of ["Book-Regular.ttf", "Book-Bold.ttf", "Book-Italic.otf", "Book-BoldItalic.ttf", "Book-Light.ttf"]) await fs.write(`fonts/${name}`, new Uint8Array(await font(name).arrayBuffer()));
  return { fs, device, family: (await listFonts(fs.root))[0]! };
}

it("uses exact KPW3 / KO3 dimensions and explicitly falls back to KPW3 for other models", () => {
  expect(screenFor("KPW3")).toMatchObject({ width: 1072, height: 1448, ppi: 300 });
  expect(screenFor("KO3")).toMatchObject({ width: 1264, height: 1680, ppi: 300 });
  expect(screenFor("other")).toEqual(screenFor("KPW3"));
});
it("groups inspected install batches by family and retains additional weights", async () => {
  const result = await inspectFontBatch([font("Book-Regular.ttf"), font("Book-Light.ttf"), font("Book-Medium.otf"), font("Second-Bold.ttf")]);
  expect(result.map(family => [family.name, family.coverage])).toEqual([["Book", ["R", "Light", "Medium"]], ["Second", ["B"]]]);
  expect(result[0]!.size).toBe(36);
});
it("rejects an entire install batch for ignored resource files, malformed fonts or case-insensitive duplicates", async () => {
  for (const files of [[font("Book.ttf"), font("._Book.ttf")], [font("Book.ttf"), new File(["bad"], "broken.otf")], [font("Book.ttf"), font("BOOK.TTF")]]) await expect(inspectFontBatch(files)).rejects.toThrow();
});
it("registers every real style in the target document only and removes the faces on cleanup", async () => {
  const { device, family } = await fontDevice(), target = fontDocument(), app = fontDocument();
  const options: unknown[] = [];
  vi.stubGlobal("document", app.document);
  vi.stubGlobal("FontFace", class { constructor(public family: string, _data: ArrayBuffer, descriptors: unknown) { options.push(descriptors); } load() { return Promise.resolve(this); } });
  const registration = new DocumentFonts(target.document); await registration.load(device, family);
  expect(target.fonts.size).toBe(5); expect(app.fonts.size).toBe(0);
  expect(options).toContainEqual({ weight: "700", style: "italic" }); expect(options).toContainEqual({ weight: "300", style: "normal" });
  registration.clear(); expect(target.fonts.size).toBe(0);
});
it("does not register a late FontFace after cleanup or leave partially loaded styles after failure", async () => {
  const { device, family } = await fontDevice(), target = fontDocument();
  const pending: Array<() => void> = [];
  vi.stubGlobal("FontFace", class { load() { return new Promise(resolve => { pending.push(() => resolve(this)); }); } });
  const registration = new DocumentFonts(target.document), loading = registration.load(device, family);
  for (let i = 0; i < 50 && pending.length !== 5; i++) await Promise.resolve();
  expect(pending).toHaveLength(5); registration.clear(); pending.forEach(resolve => resolve()); await loading; expect(target.fonts.size).toBe(0);
  vi.stubGlobal("FontFace", class { load() { return Promise.reject(new Error("invalid font")); } });
  await expect(registration.load(device, family)).rejects.toThrow("invalid font"); expect(target.fonts.size).toBe(0);
});
it("updates the profile stylesheet without altering book styles and clears document fonts and link handlers", async () => {
  const { device, family } = await fontDevice(), target = previewDocumentFixture();
  vi.stubGlobal("FontFace", class { load() { return Promise.resolve(this); } });
  const preview = new PreviewDocument(target.document);
  const base = target.head.firstChild!, profile = target.head.lastChild!;
  expect(base.textContent).toContain("font-size: 55px");
  expect(base.textContent).toContain("margin: 52px 80px 70px !important"); expect(base.textContent).toContain("body { line-height: 1.75; }");
  expect(base.textContent).toContain("scrollbar-width: none !important");
  preview.setGeometry(kindleGeometry("KPW3", "medium")); expect(base.textContent).toContain("margin: 52px 137px 70px !important");
  preview.setGeometry(kindleGeometry("KO3", "wide")); expect(base.textContent).toContain("font-size: 55px");
  await preview.update("p { line-height: 1.6; }", device, family); expect(target.fonts.size).toBe(5);
  await preview.update("p { line-height: 1.8; }", device, family); expect(profile.textContent).toContain("1.8"); expect(target.fonts.size).toBe(5);
  await preview.update(null, null); expect(target.fonts.size).toBe(0); expect(profile.textContent).toContain("1.8");
  preview.destroy(); expect(base.parentNode).toBeNull(); expect(profile.parentNode).toBeNull(); expect(target.document.removeEventListener).toHaveBeenCalledWith("click", expect.any(Function));
});

it("counts exact and partial pages, clamps positions and never adds a blank last page", () => {
  for (const width of [1072, 1264]) {
    expect(previewPagination(width, 0)).toMatchObject({ step: width, count: 1, page: 1, left: 0 });
    expect(previewPagination(width, width * 3, 99)).toEqual({ step: width, count: 3, page: 3, left: width * 2, end: width * 3 });
    expect(previewPagination(width, width * 3 - 80, 3)).toMatchObject({ count: 3, left: width * 2 });
    expect(previewPagination(width, width * 3 + 100, -5)).toMatchObject({ count: 4, page: 1, left: 0 });
    expect(previewPagination(width, width, 5)).toMatchObject({ count: 1, page: 1 });
    expect(previewAnchorPage(40, width * 2, width)).toBe(3);
    expect(previewAnchorPage(-width + 40, width * 2, width)).toBe(2);
  }
});

it("pins device body geometry over author margins while keeping direct children, typography and signed profile units", async () => {
  for (const model of ["KPW3", "KO3", "other"] as const) for (const preset of ["narrow", "medium", "wide"] as const) {
    const target = previewDocumentFixture(), { document, body, head } = target;
    const book = document.createElement("style"), p = document.createElement("p");
    book.textContent = "html, body { margin: 9em !important; padding: 20% !important; } body { font: 60px/1.7 serif; color: red; }";
    head.appendChild(book); body.appendChild(p);
    body.style.setProperty("margin", "30px", "important"); body.style.setProperty("font-family", "Book");
    const preview = new PreviewDocument(document), geometry = kindleGeometry(model, preset);
    preview.setGeometry(geometry);
    expect(Number.isInteger(geometry.column)).toBe(true);
    expect(body.style.getPropertyValue("width")).toBe(`${geometry.column}px`);
    expect(body.style.getPropertyValue("column-gap")).toBe(`${2 * geometry.width - geometry.column}px`);
    expect(body.style.getPropertyValue("margin")).toBe(`${geometry.top}px ${geometry.side}px ${geometry.bottom}px`);
    expect(body.style.getPropertyPriority("margin")).toBe("important");
    expect(body.style.getPropertyValue("font-family")).toBe("Book");
    expect(geometry.lineHeight).toBe(1.75);
    for (const [value, unit, suffix] of [[-4.8, "percent", "%"], [-0.8, "em", "em"], [5, "percent", "%"]] as const) {
      await preview.update(`body > * { margin-left: ${value}${suffix} !important; margin-right: ${value}${suffix} !important; }`, null);
      expect(geometry.side + marginXPx(geometry, value, unit)).toBeCloseTo(geometry.side + (unit === "percent" ? geometry.column * value / 100 : value * (geometry.baseEmPx ?? geometry.emPx)));
      expect(body.firstChild).toBe(p); expect(p.parentNode).toBe(body);
    }
    // A profile may push text past the screen edge; the preview must not clamp it.
    expect(geometry.side + marginXPx(geometry, -40, "percent")).toBeLessThan(0);
    expect(book.textContent).toContain("font: 60px/1.7 serif");
    preview.destroy(); expect(body.style.getPropertyValue("margin")).toBe("30px"); expect(book.parentNode).toBe(head);
  }
});

it("fills only the last gutter, ignores its old spacer on reflow and turns keys/taps without hijacking links or selection", async () => {
  const target = previewDocumentFixture(), change = vi.fn(), boundary = vi.fn();
  const preview = new PreviewDocument(target.document, change, boundary);
  expect(change).toHaveBeenLastCalledWith({ page: 1, count: 3 });
  for (const key of ["ArrowRight", "PageDown"]) expect(target.dispatch("keydown", { key }).preventDefault).toHaveBeenCalled();
  expect(target.root.scrollLeft).toBe(4288);
  expect(target.root.style.getPropertyValue("--bindery-page-end")).toBe("6431px");
  target.dispatch("keydown", { key: "PageDown" }); expect(boundary).toHaveBeenLastCalledWith(1);
  target.dispatch("keydown", { key: "ArrowLeft" }); target.dispatch("keydown", { key: "PageUp" });
  expect(change).toHaveBeenLastCalledWith({ page: 1, count: 3 });
  target.dispatch("click", { clientX: 20 }); expect(boundary).toHaveBeenLastCalledWith(-1);
  target.dispatch("click", { clientX: 1000 }); expect(change).toHaveBeenLastCalledWith({ page: 2, count: 3 });
  target.dispatch("click", { clientX: 536 }); expect(change).toHaveBeenLastCalledWith({ page: 2, count: 3 });
  Object.assign(target.document, { getSelection: () => ({ isCollapsed: false }) });
  target.dispatch("click", { clientX: 1000 }); expect(change).toHaveBeenLastCalledWith({ page: 2, count: 3 });
  const link = { closest: (selector: string) => selector.includes("a") ? {} : null };
  expect(target.dispatch("click", { target: link, clientX: 1000 }).preventDefault).toHaveBeenCalled();
  for (const extra of [{ ctrlKey: true }, { defaultPrevented: true }, { target: link }]) {
    expect(target.dispatch("keydown", { key: "ArrowRight", ...extra }).preventDefault).not.toHaveBeenCalled();
  }
  target.setExtent(1072); await preview.update("p { line-height: 1.5 }", null);
  expect(change).toHaveBeenLastCalledWith({ page: 1, count: 1 }); expect(target.root.scrollLeft).toBe(0);
  preview.destroy(); const calls = change.mock.calls.length; target.dispatch("keydown", { key: "ArrowRight" }); await Promise.resolve(); expect(change).toHaveBeenCalledTimes(calls);
});

it("keeps a caret text offset through CSS, model, margin, font-ready and image reflow, then clamps a removed anchor", async () => {
  const target = previewDocumentFixture(), { document, body, root } = target;
  const p = document.createElement("p"), text = document.createTextNode("字".repeat(80)), image = document.createElement("img");
  p.appendChild(text); body.appendChild(p); body.appendChild(image);
  let charsPerPage = 10, releaseFonts!: () => void;
  target.fonts.ready = new Promise<void>(resolve => { releaseFonts = resolve; });
  Object.assign(body, { contains: (node: Node) => node === text && text.isConnected });
  Object.assign(document, {
    caretPositionFromPoint: () => ({ offsetNode: text, offset: Math.round(root.scrollLeft / Number.parseFloat(root.style.getPropertyValue("width"))) * charsPerPage }),
    createTreeWalker: () => ({ nextNode: () => false }),
    createRange: () => {
      let offset = 0;
      return { setStart: (_node: Node, value: number) => { offset = value; }, setEnd: vi.fn(),
        getClientRects: () => {
          const left = Math.floor(offset / charsPerPage) * Number.parseFloat(root.style.getPropertyValue("width")) + 36 - root.scrollLeft;
          return [{ left, right: left + 55, top: 80, bottom: 135 }];
        } };
    },
  });
  const change = vi.fn(), preview = new PreviewDocument(document, change);
  preview.open(3); expect(root.scrollLeft).toBe(4288); // First visible text offset = 40 at the wider pitch.
  // setGeometry captures before mutating geometry; CSS then applies within the same reflow.
  preview.setGeometry(kindleGeometry("KPW3", "medium")); charsPerPage = 15; target.setExtent(3 * 2144 - 137);
  await preview.update("p { line-height: 2 }", null);
  expect(change).toHaveBeenLastCalledWith({ page: 2, count: 3 }); // Offset 40, now first visible = 30.
  preview.setGeometry(kindleGeometry("KO3", "narrow")); charsPerPage = 10; target.setExtent(4 * 2528 - 94);
  await preview.update("p { font-family: Book }", null);
  expect(root.scrollLeft).toBe(2528); expect(change).toHaveBeenLastCalledWith({ page: 2, count: 4 }); // Offset 30, now first = 30.
  charsPerPage = 5; releaseFonts(); await Promise.resolve();
  expect(change).toHaveBeenLastCalledWith({ page: 3, count: 4 });
  charsPerPage = 8; fire(image, "load");
  expect(change).toHaveBeenLastCalledWith({ page: 2, count: 4 });
  // FontFaceSet loadingdone uses the same stored text anchor, not a page ratio.
  charsPerPage = 20; target.fonts.addEventListener.mock.calls[0]![1]();
  expect(change).toHaveBeenLastCalledWith({ page: 1, count: 4 });
  preview.open(4);
  body.removeChild(p); target.setExtent(1264); await preview.update("", null);
  expect(change).toHaveBeenLastCalledWith({ page: 1, count: 1 });
  preview.destroy();
});

it("finds the first visible character with Range when caret APIs are absent and preserves it after a device FontFace loads", async () => {
  const target = previewDocumentFixture(), { document, root, body } = target, { device, family } = await fontDevice();
  const p = document.createElement("p"), text = document.createTextNode("字".repeat(80)); p.appendChild(text); body.appendChild(p);
  Object.assign(p, { closest: () => null });
  let charsPerPage = 10;
  const selectedOffsets: number[] = [], pending: Array<() => void> = [];
  Object.assign(document, {
    createTreeWalker: () => { let visited = false; return { currentNode: text, nextNode: () => { if (visited) return false; visited = true; return true; } }; },
    createRange: () => {
      let offset = 0, contents = false;
      const rect = () => {
        const left = Math.floor(offset / charsPerPage) * 1072 + 36 - root.scrollLeft;
        return { left, right: left + 55, top: 80, bottom: 135 };
      };
      return { selectNodeContents: () => { contents = true; }, setStart: (_node: Node, value: number) => { selectedOffsets.push(value); offset = value; contents = false; }, setEnd: vi.fn(),
        getBoundingClientRect: rect, getClientRects: () => contents ? [{ left: -root.scrollLeft, right: 8000 - root.scrollLeft, top: 80, bottom: 135 }] : [rect()] };
    },
  });
  vi.stubGlobal("FontFace", class { load() { return new Promise(resolve => { pending.push(() => resolve(this)); }); } });
  const change = vi.fn(), preview = new PreviewDocument(document, change); preview.open(3);
  const loading = preview.update('body { font-family: "Book" }', device, family);
  for (let i = 0; i < 50 && pending.length !== 5; i++) await Promise.resolve();
  expect(pending).toHaveLength(5);
  charsPerPage = 15; pending.forEach(resolve => resolve()); await loading;
  expect(selectedOffsets).toContain(40); expect(change).toHaveBeenLastCalledWith({ page: 2, count: 3 });
  expect(target.fonts.size).toBe(5); preview.destroy();
});
it("loads a requested real EPUB chapter list and defaults to the most recent book without changing reading progress or EPUB bytes", () => {
  const fixture = readerFixture({ updated_at: "2026-10-19T10:00:00Z" }); cleanups.push(fixture.cleanup);
  const { library, id } = fixture, path = epubPath(library.base, id), before = readFileSync(path);
  const recent = "e".repeat(32), meta = { ...fixture.meta, book_id: recent, title: "最近更新", updated_at: "2026-10-20T10:00:00Z" };
  library.saveMetadata(meta);
  // saveMetadata creates the book directory through the project's storage API.
  writeFileSync(epubPath(library.base, recent), before);
  const explicit = previewData(library, id); expect(explicit.bookId).toBe(id); expect(explicit.sections.length).toBeGreaterThan(0);
  expect(explicit.sections).toEqual(previewChapters(library, id)); expect(previewData(library, "").bookId).toBe(recent);
  expect(previewData(library, "missing")).toMatchObject({ bookId: recent, error: "指定书籍不可预览，已选择最近更新的书籍。" });
  expect(library.db.getReaderProgress(id)).toBeNull(); expect(readFileSync(path)).toEqual(before);
});
it("handles empty/missing EPUBs and exposes a recoverable error for malformed chapter data", () => {
  const fixture = readerFixture(); cleanups.push(fixture.cleanup);
  const path = epubPath(fixture.library.base, fixture.id);
  writeFileSync(path, "broken archive"); expect(previewData(fixture.library, fixture.id).error).not.toBe("");
  rmSync(path); expect(previewData(fixture.library, "")).toEqual({ books: [], bookId: "", sections: [], error: "" });
  expect(() => previewChapters(fixture.library, "../invalid")).toThrow("书籍不存在");
});

it("keeps the book's own html/body spacing on a Kobo page and redirects system fonts to the reader fallback", () => {
  const target = previewDocumentFixture(), { document, body, head } = target;
  const p = document.createElement("p"); body.appendChild(p);
  // The synthetic DOM has no cascade: the book's `html, body { padding: 0.5em }` at 53.5px arrives as computed values.
  const computed = (element: Element) => ({ getPropertyValue: (name: string) => name.startsWith("padding-") && (element === document.documentElement || element === body) ? "26.75px" : "0px" });
  const sources = new Map([["embedded", 'local("SongTi"), url("../Fonts/a.ttf")'], ["system", 'local("宋体"), local("SongTi")']]);
  const rule = (name: string) => ({ cssText: `@font-face { font-family: ${name}; }`, style: { getPropertyValue: () => sources.get(name)!, setProperty: (_property: string, value: string) => { sources.set(name, value); } } });
  Object.defineProperties(document, {
    defaultView: { value: { getComputedStyle: computed } },
    styleSheets: { value: [{ cssRules: [rule("embedded"), { cssText: "@media screen { }", cssRules: [rule("system")] }] }] },
  });
  const geometry = koboGeometry(), preview = new PreviewDocument(document); preview.setGeometry(geometry);
  const base = head.firstChild!;
  // 40px device margin + 26.75px html + 26.75px body on each side, every page.
  expect(body.style.getPropertyValue("margin")).toBe("96px 93.5px 160px");
  expect(body.style.getPropertyValue("width")).toBe(`${1264 - 187}px`); expect(body.style.getPropertyValue("column-gap")).toBe(`${2 * 1264 - (1264 - 187)}px`);
  // Top and bottom insets open and close the flow instead of repeating on each page.
  const spacers = Array.from(body.childNodes).filter(node => (node as Element).hasAttribute?.("data-bindery-inset")) as Element[];
  expect(spacers.map(spacer => /height: ([\d.]+px)/.exec(spacer.getAttribute("style")!)?.[1])).toEqual(["53.5px", "53.5px"]);
  expect(body.firstChild).toBe(spacers[0]); expect(body.lastChild).toBe(spacers[1]);
  expect(sources.get("embedded")).toBe('url("../Fonts/a.ttf")');
  expect(sources.get("system")).toBe(geometry.fallbackSources);
  expect(base.textContent).toContain(`@font-face { font-family: "宋体"; src: ${geometry.fallbackSources}; }`);
  expect(base.textContent).toContain("font-family: sans-serif;");
  preview.destroy(); expect(Array.from(body.childNodes)).toEqual([p]);
});

it("lay pages on a double-width pitch so negative profile margins cannot leak into the next page", () => {
  const target = previewDocumentFixture(), geometry = koboGeometry(), preview = new PreviewDocument(target.document);
  preview.setGeometry(geometry);
  const column = Number.parseFloat(target.body.style.getPropertyValue("width")), gap = Number.parseFloat(target.body.style.getPropertyValue("column-gap")), pitch = 2 * geometry.width;
  expect(column + gap).toBe(pitch);
  // -20% on both sides expands the block by 40% of the column, still short of the next page's window.
  expect(geometry.side + geometry.column * 1.4).toBeLessThan(pitch);
  expect(geometry.side - geometry.column * 0.2).toBeLessThan(0);
  preview.open(2); expect(target.root.scrollLeft).toBe(pitch);
  expect(previewPagination(pitch, 3 * pitch - 80, 99)).toMatchObject({ count: 3, page: 3, left: 2 * pitch });
  preview.destroy();
});

it("redirects desktop and local() fonts for both kinds while keeping the Kindle's built-in faces", () => {
  const target = previewDocumentFixture(), { document, head } = target;
  const sources = new Map([["Book", 'local("Songti SC"), url("../Fonts/book.ttf")'], ["宋体", 'local("宋体"), url("../Fonts/song.ttf")']]);
  const rule = (family: string) => ({ cssText: `@font-face { font-family: ${family}; }`, style: {
    getPropertyValue: (property: string) => property === "font-family" ? family : sources.get(family)!,
    setProperty: (_property: string, value: string) => { sources.set(family, value); },
  } });
  Object.defineProperty(document, "styleSheets", { value: [{ cssRules: [rule("Book"), rule("宋体")] }], configurable: true });
  const preview = new PreviewDocument(document), base = head.firstChild!;
  preview.setGeometry(kindleGeometry("KPW3"));
  expect(sources.get("Book")).toBe('url("../Fonts/book.ttf")');
  expect(sources.get("宋体")).toBe('local("宋体"), url("../Fonts/song.ttf")');
  expect(base.textContent).toContain(`@font-face { font-family: "SimSun"; src: ${kindleGeometry("KPW3").fallbackSources}; }`);
  expect(base.textContent).not.toContain('@font-face { font-family: "宋体"');
  preview.setGeometry(koboGeometry());
  expect(sources.get("宋体")).toBe('url("../Fonts/song.ttf")');
  preview.destroy();
});
