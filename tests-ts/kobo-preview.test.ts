import { describe, expect, it } from "vitest";
import { KOBO_LIBRA2_PAGE, KOBO_PREVIEW_DEFAULTS, koboPreviewCss, koboPreviewEstimate, koboPreviewGeometry, koboPreviewSettings } from "../src/features/devices/kobo-page";

describe("Kobo approximate preview settings", () => {
  it("matches the Libra 2 measurement at the defaults", () => {
    expect(koboPreviewEstimate(KOBO_PREVIEW_DEFAULTS)).toEqual({ charsPerLine: 22, linesPerPage: 17 });
    expect(koboPreviewGeometry(KOBO_PREVIEW_DEFAULTS)).toMatchObject({ emPx: 53.5, lineHeight: 1.54, width: 1264, height: 1680, column: 1184 });
  });

  it("scales the font and line spacing while the page geometry stays fixed", () => {
    const larger = koboPreviewSettings({ scale: 1.2, lineHeight: 1.8, font: null });
    expect(koboPreviewGeometry(larger)).toMatchObject({ emPx: 64.2, lineHeight: 1.8, column: 1184, contentHeight: KOBO_LIBRA2_PAGE.contentHeight });
    expect(koboPreviewEstimate(larger)).toEqual({ charsPerLine: 18, linesPerPage: 12 });
  });

  it("clamps or drops unusable stored values", () => {
    expect(koboPreviewSettings({ scale: 9, lineHeight: 0.2, font: "  " })).toEqual({ scale: 1.6, lineHeight: 1, font: null });
    expect(koboPreviewSettings("garbage")).toEqual(KOBO_PREVIEW_DEFAULTS);
    expect(koboPreviewSettings({ scale: Number.NaN, lineHeight: "2", font: "霞鹜文楷" })).toEqual({ ...KOBO_PREVIEW_DEFAULTS, font: "霞鹜文楷" });
  });

  it("overrides the book's line height always and its typeface only when a font is chosen", () => {
    expect(koboPreviewCss(KOBO_PREVIEW_DEFAULTS)).toBe("html body, html body * { line-height: 1.54 !important; }");
    expect(koboPreviewCss({ ...KOBO_PREVIEW_DEFAULTS, font: 'A "B"' })).toContain('font-family: "A \\"B\\"", sans-serif !important;');
  });
});
