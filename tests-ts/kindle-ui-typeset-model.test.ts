import { afterEach, expect, it, vi } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { inspectFontBatch, previewAnchorPage, previewPagination, screenFor } from "../src/features/kindle/typeset/model";
import { DocumentFonts, PreviewDocument } from "../src/features/kindle/typeset/frame";
import { previewChapters, previewData } from "../src/features/kindle/typeset/preview.server";
import { listFonts } from "../src/client/kindle/fonts";
import { pairDevice } from "../src/client/kindle/identity";
import { epubPath } from "../src/server/storage";
import { readerFixture } from "./fixtures/reader/support";
import { fakeKindle } from "./support/fake-fs";
import { convertMarginX, kindlePageGeometry, kindlePreviewMetrics, minimumMarginX } from "../src/client/kindle/margins";
import { previewDocumentFixture } from "./support/kindle-preview-dom";
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
it("matches all KPW3 observations and labels scaled KO3 / other calibration as estimates", () => {
  expect(kindlePreviewMetrics("KPW3", "narrow", 0, "percent")).toMatchObject({ emPx: 55, deviceMarginPx: 80, contentWidthPx: 912, charsPerLine: 16, measured: true });
  expect(kindlePreviewMetrics("KPW3", "narrow", -0.8, "em")).toMatchObject({ sideMarginPx: 36, contentWidthPx: 1000, charsPerLine: 18 });
  expect(kindlePreviewMetrics("KPW3", "narrow", -4.8, "percent")).toMatchObject({ charsPerLine: 18 });
  expect(kindlePreviewMetrics("KPW3", "narrow", -4.8, "percent").sideMarginPx).toBeCloseTo(80 - 0.048 * 912);
  expect(kindlePreviewMetrics("KPW3", "medium", null, "percent").charsPerLine).toBe(14);
  expect(kindlePreviewMetrics("KPW3", "wide", null, "em").charsPerLine).toBe(11);
  expect(kindlePreviewMetrics("KPW3", "narrow", 1, "em").charsPerLine).toBe(14);
  // Percent resolves against the column left by the Kindle's own margin, so it shrinks with wider presets.
  expect(kindlePreviewMetrics("KPW3", "medium", -4.8, "percent").sideMarginPx).toBeCloseTo(137 - 0.048 * 798);
  expect(convertMarginX("KPW3", "narrow", -4.8, "percent", "em")).toBeCloseTo(-0.8, 1);
  expect(convertMarginX("KPW3", "narrow", -0.8, "em", "percent")).toBeCloseTo(-4.82, 2);
  expect(convertMarginX("KPW3", "wide", 2, "percent", "percent")).toBe(2);
  const oasis = kindlePreviewMetrics("KO3", "narrow", -0.8, "em");
  expect(oasis.emPx).toBeCloseTo(55 * 1264 / 1072);
  expect(oasis.deviceMarginPx).toBe(Math.round(80 * 1264 / 1072));
  expect(oasis).toMatchObject({ charsPerLine: 18, measured: false });
  expect(kindlePreviewMetrics("KO3", "narrow", -4.8, "percent")).toMatchObject({ charsPerLine: 18, measured: false });
  expect(kindlePreviewMetrics("other", "narrow", 0, "percent")).toMatchObject({ charsPerLine: 16, measured: false });
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
  expect(base.textContent).toContain("margin: 80px 80px 80px !important");
  expect(base.textContent).toContain("scrollbar-width: none !important");
  preview.setDevice("KPW3", "medium"); expect(base.textContent).toContain("margin: 137px 137px 137px !important");
  preview.setDevice("KO3", "wide"); expect(base.textContent).toContain(`font-size: ${55 * 1264 / 1072}px`);
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
    const preview = new PreviewDocument(document), geometry = kindlePageGeometry(model, preset);
    preview.setDevice(model, preset);
    const metrics = kindlePreviewMetrics(model, preset, -4.8, "percent");
    expect(geometry.column + geometry.gap).toBe(geometry.width);
    expect(Number.isInteger(geometry.column)).toBe(true);
    expect(body.style.getPropertyValue("width")).toBe(`${geometry.column}px`);
    expect(body.style.getPropertyValue("column-gap")).toBe(`${2 * geometry.side}px`);
    expect(body.style.getPropertyValue("margin")).toBe(`${geometry.top}px ${geometry.side}px ${geometry.bottom}px`);
    expect(body.style.getPropertyPriority("margin")).toBe("important");
    expect(body.style.getPropertyValue("font-family")).toBe("Book");
    expect(metrics).toMatchObject({ topMarginPx: geometry.side, bottomMarginPx: geometry.side, verticalMeasured: false });
    for (const [value, unit, suffix] of [[-4.8, "percent", "%"], [-0.8, "em", "em"], [5, "percent", "%"]] as const) {
      await preview.update(`body > * { margin-left: ${value}${suffix} !important; margin-right: ${value}${suffix} !important; }`, null);
      const actual = kindlePreviewMetrics(model, preset, value, unit);
      expect(actual.sideMarginPx).toBeCloseTo(geometry.side + (unit === "percent" ? geometry.column * value / 100 : value * geometry.emPx));
      expect(actual.sideMarginPx < geometry.side).toBe(value < 0);
      expect(body.firstChild).toBe(p); expect(p.parentNode).toBe(body);
    }
    expect(kindlePreviewMetrics(model, preset, minimumMarginX(model, preset, "percent"), "percent").sideMarginPx).toBeCloseTo(0);
    expect(book.textContent).toContain("font: 60px/1.7 serif");
    preview.destroy(); expect(body.style.getPropertyValue("margin")).toBe("30px"); expect(book.parentNode).toBe(head);
  }
});

it("fills only the last gutter, ignores its old spacer on reflow and turns keys/taps without hijacking links or selection", async () => {
  const target = previewDocumentFixture(), change = vi.fn(), boundary = vi.fn();
  const preview = new PreviewDocument(target.document, change, boundary);
  expect(change).toHaveBeenLastCalledWith({ page: 1, count: 3 });
  for (const key of ["ArrowRight", "PageDown"]) expect(target.dispatch("keydown", { key }).preventDefault).toHaveBeenCalled();
  expect(target.root.scrollLeft).toBe(2144);
  expect(target.root.style.getPropertyValue("--bindery-page-end")).toBe("3215px");
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
  preview.open(3); expect(root.scrollLeft).toBe(2144); // First visible text offset = 20.
  // setDevice captures before mutating geometry; CSS then applies within the same reflow.
  preview.setDevice("KPW3", "medium"); charsPerPage = 15; target.setExtent(3 * 1072 - 137);
  await preview.update("p { line-height: 2 }", null);
  expect(change).toHaveBeenLastCalledWith({ page: 2, count: 3 }); // Offset 20, now first visible = 15.
  preview.setDevice("KO3", "narrow"); charsPerPage = 10; target.setExtent(4 * 1264 - 94);
  await preview.update("p { font-family: Book }", null);
  expect(root.scrollLeft).toBe(1264); expect(change).toHaveBeenLastCalledWith({ page: 2, count: 4 }); // Offset 15, now first = 10.
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
  expect(selectedOffsets).toContain(20); expect(change).toHaveBeenLastCalledWith({ page: 2, count: 3 });
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
