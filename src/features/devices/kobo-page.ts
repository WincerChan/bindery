import type { PageGeometry } from "../kindle/typeset/frame";

/**
 * Libra 2 as measured on 2026-10-22 with the owner's settings (minimum margins, line spacing about a
 * third along, font size about half): 22 CJK characters per line and 17 lines per page. Enough for an
 * approximate look; pagination will differ slightly from the device.
 */
export const KOBO_LIBRA2_PAGE: PageGeometry = {
  width: 1264, height: 1680, emPx: 53.5, lineHeight: 1.54, side: 40, top: 96, bottom: 160,
  column: 1264 - 2 * 40, gap: 2 * 40, contentHeight: 1680 - 96 - 160,
  // Kobo falls back to its own sans CJK face when the book does not pick (or embed) one.
  fontFamily: "sans-serif", bookInsets: true, embeddedFontsOnly: true,
  fallbackSources: ["Microsoft YaHei", "Microsoft YaHei UI", "PingFang SC", "PingFangSC-Regular", "Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC", "WenQuanYi Micro Hei"].map(name => `local("${name}")`).join(", "),
};

/** Reader settings for the preview. Ranges are approximate, not Kobo's own slider steps. */
export interface KoboPreviewSettings { scale: number; lineHeight: number; font: string | null }
export const KOBO_PREVIEW_DEFAULTS: KoboPreviewSettings = { scale: 1, lineHeight: KOBO_LIBRA2_PAGE.lineHeight, font: null };
export const KOBO_SCALE_RANGE = { min: 0.7, max: 1.6, step: 0.05 } as const;
export const KOBO_LINE_HEIGHT_RANGE = { min: 1, max: 2.4, step: 0.02 } as const;
const clamp = (value: unknown, range: { min: number; max: number }, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(range.max, Math.max(range.min, value)) : fallback;

/** Accepts stored or edited values; anything unusable falls back to the measured defaults. */
export function koboPreviewSettings(raw: unknown): KoboPreviewSettings {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    scale: clamp(value.scale, KOBO_SCALE_RANGE, KOBO_PREVIEW_DEFAULTS.scale),
    lineHeight: clamp(value.lineHeight, KOBO_LINE_HEIGHT_RANGE, KOBO_PREVIEW_DEFAULTS.lineHeight),
    font: typeof value.font === "string" && value.font.trim() ? value.font.slice(0, 200) : null,
  };
}
export function koboPreviewGeometry(settings: KoboPreviewSettings): PageGeometry {
  return { ...KOBO_LIBRA2_PAGE, emPx: Math.round(KOBO_LIBRA2_PAGE.emPx * settings.scale * 100) / 100, lineHeight: settings.lineHeight };
}
/** Kobo's line spacing and a chosen typeface override the book's; book-relative font sizes still scale. */
export function koboPreviewCss(settings: KoboPreviewSettings): string {
  const rules = [`html body, html body * { line-height: ${settings.lineHeight} !important; }`];
  if (settings.font) rules.push(`html body, html body * { font-family: ${JSON.stringify(settings.font)}, sans-serif !important; }`);
  return rules.join("\n");
}
/** Unstyled CJK text: whole characters per line and whole lines per page. */
export function koboPreviewEstimate(settings: KoboPreviewSettings) {
  const { emPx, column, contentHeight } = koboPreviewGeometry(settings);
  return { charsPerLine: Math.floor(column / emPx), linesPerPage: Math.floor(contentHeight / (emPx * settings.lineHeight)) };
}
