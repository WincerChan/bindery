import { afterEach, expect, it, vi } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { inspectFontBatch, screenFor } from "../src/features/kindle/typeset/model";
import { DocumentFonts, PreviewDocument } from "../src/features/kindle/typeset/frame";
import { previewChapters, previewData } from "../src/features/kindle/typeset/preview.server";
import { listFonts } from "../src/client/kindle/fonts";
import { pairDevice } from "../src/client/kindle/identity";
import { epubPath } from "../src/server/storage";
import { readerFixture } from "./fixtures/reader/support";
import { fakeKindle } from "./support/fake-fs";
import { convertMarginX, kindlePreviewMetrics } from "../src/client/kindle/margins";

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
  expect(oasis.deviceMarginPx).toBeCloseTo(80 * 1264 / 1072);
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
  const { device, family } = await fontDevice(), target = fontDocument();
  vi.stubGlobal("FontFace", class { load() { return Promise.resolve(this); } });
  const preview = new PreviewDocument(target.document);
  expect(target.styles[0]!.textContent).toContain("font-size: 55px");
  expect(target.styles[0]!.textContent).toContain("padding-left: 80px");
  expect(target.styles[0]!.textContent).toContain("scrollbar-width: none !important");
  preview.setDevice("KPW3", "medium"); expect(target.styles[0]!.textContent).toContain("padding-right: 137px");
  preview.setDevice("KO3", "wide"); expect(target.styles[0]!.textContent).toContain(`font-size: ${55 * 1264 / 1072}px`);
  await preview.update("p { line-height: 1.6; }", device, family); expect(target.fonts.size).toBe(5);
  await preview.update("p { line-height: 1.8; }", device, family); expect(target.styles[1]!.textContent).toContain("1.8"); expect(target.fonts.size).toBe(5);
  await preview.update(null, null); expect(target.fonts.size).toBe(0); expect(target.styles[1]!.textContent).toContain("1.8");
  preview.destroy(); expect(target.styles.every(style => style.remove.mock.calls.length === 1)).toBe(true); expect(target.document.removeEventListener).toHaveBeenCalledWith("click", expect.any(Function));
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
