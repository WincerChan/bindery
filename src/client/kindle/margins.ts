import { KINDLE_MODELS, type KindleModel } from "./identity";

export const KINDLE_MARGIN_PRESETS = { narrow: "窄", medium: "中", wide: "宽" } as const;
export type KindleMarginPreset = keyof typeof KINDLE_MARGIN_PRESETS;

/** No off-screen headroom: negative block margins may consume only the device's side margin. */
export function minimumMarginX(model: KindleModel, preset: KindleMarginPreset): number {
  const { emPx, sideMargins } = KINDLE_MODELS[model].typesetting;
  return -sideMargins[preset] / emPx;
}

/** CJK = 1em at size 7; excludes book-specific indentation, font sizing and custom CSS. */
export function kindlePreviewMetrics(model: KindleModel, preset: KindleMarginPreset, marginX: number | null) {
  const { emPx, sideMargins, measured } = KINDLE_MODELS[model].typesetting;
  const width = KINDLE_MODELS[model].width ?? KINDLE_MODELS.KPW3.width;
  const deviceMarginPx = sideMargins[preset], sideMarginPx = deviceMarginPx + (marginX ?? 0) * emPx;
  const contentWidthPx = Math.max(0, width - 2 * sideMarginPx);
  return { emPx, deviceMarginPx, sideMarginPx, contentWidthPx, charsPerLine: Math.floor(contentWidthPx / emPx), measured };
}
