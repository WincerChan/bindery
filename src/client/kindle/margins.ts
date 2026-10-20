import { KINDLE_MODELS, type KindleModel } from "./identity";

export const KINDLE_MARGIN_PRESETS = { narrow: "窄", medium: "中", wide: "宽" } as const;
export type KindleMarginPreset = keyof typeof KINDLE_MARGIN_PRESETS;
/** `em` is the legacy unit and scales with the Kindle font size; `percent` resolves against the text column. */
export const MARGIN_X_UNITS = { em: "em", percent: "%" } as const;
export type MarginXUnit = keyof typeof MARGIN_X_UNITS;
/** Both sides together must leave part of the text column. */
export const MAXIMUM_MARGIN_X = { em: 20, percent: 40 } as const satisfies Record<MarginXUnit, number>;

function calibration(model: KindleModel, preset: KindleMarginPreset) {
  const { emPx, sideMargins, measured } = KINDLE_MODELS[model].typesetting;
  const width = KINDLE_MODELS[model].width ?? KINDLE_MODELS.KPW3.width;
  const deviceMarginPx = sideMargins[preset];
  // Per CSS, a percentage margin on `body > *` resolves against body's content width:
  // the screen minus the Kindle's own side margins.
  return { emPx, measured, width, deviceMarginPx, columnPx: width - 2 * deviceMarginPx };
}

export function marginXPx(model: KindleModel, preset: KindleMarginPreset, marginX: number | null, unit: MarginXUnit): number {
  if (marginX === null) return 0;
  const { emPx, columnPx } = calibration(model, preset);
  return unit === "percent" ? marginX / 100 * columnPx : marginX * emPx;
}

/** No off-screen headroom: negative block margins may consume only the device's side margin. */
export function minimumMarginX(model: KindleModel, preset: KindleMarginPreset, unit: MarginXUnit): number {
  const { emPx, deviceMarginPx, columnPx } = calibration(model, preset);
  return unit === "percent" ? -deviceMarginPx / columnPx * 100 : -deviceMarginPx / emPx;
}

/** The same physical margin in the other unit, at Kindle size 7. */
export function convertMarginX(model: KindleModel, preset: KindleMarginPreset, marginX: number, from: MarginXUnit, to: MarginXUnit): number {
  if (from === to) return marginX;
  const { emPx, columnPx } = calibration(model, preset), px = marginXPx(model, preset, marginX, from);
  return to === "percent" ? px / columnPx * 100 : px / emPx;
}

/** CJK = 1em at size 7; excludes book-specific indentation, font sizing and custom CSS. */
export function kindlePreviewMetrics(model: KindleModel, preset: KindleMarginPreset, marginX: number | null, unit: MarginXUnit) {
  const { emPx, measured, width, deviceMarginPx } = calibration(model, preset);
  const sideMarginPx = deviceMarginPx + marginXPx(model, preset, marginX, unit);
  const contentWidthPx = Math.max(0, width - 2 * sideMarginPx);
  const vertical = KINDLE_MODELS[model].typesetting.verticalMargins[preset];
  return { emPx, deviceMarginPx, sideMarginPx, contentWidthPx, charsPerLine: Math.floor(contentWidthPx / emPx), measured,
    topMarginPx: vertical.top, bottomMarginPx: vertical.bottom, verticalMeasured: vertical.measured };
}

/** Integer device pixels keep every column pitch equal to exactly one screen. */
export function kindlePageGeometry(model: KindleModel, preset: KindleMarginPreset) {
  const screen = KINDLE_MODELS[model === "other" ? "KPW3" : model];
  const { emPx, deviceMarginPx: side, topMarginPx: top, bottomMarginPx: bottom } = kindlePreviewMetrics(model, preset, null, "percent");
  return { width: screen.width, height: screen.height, emPx, side, top, bottom,
    column: screen.width - 2 * side, gap: 2 * side, contentHeight: screen.height - top - bottom };
}
