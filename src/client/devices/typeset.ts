import { kindleModelInfo, koboModelInfo, type DeviceKind } from "./models";

import { SCREEN_PANELS, type ScreenPanel, type ScreenPanelId } from "./panels";
export { SCREEN_PANELS } from "./panels";
export type { ScreenPanel, ScreenPanelId } from "./panels";

export const FALLBACK_PANELS: Record<DeviceKind, ScreenPanelId> = { kindle: "1072x1448", kobo: "1264x1680" };

/** `em` is the legacy unit and scales with the device font size; `percent` resolves against the text column. */
export const MARGIN_X_UNITS = { em: "em", percent: "%" } as const;
export type MarginXUnit = keyof typeof MARGIN_X_UNITS;
/** Both sides together must leave part of the text column. */
export const MAXIMUM_MARGIN_X = { em: 20, percent: 40 } as const satisfies Record<MarginXUnit, number>;

const BASE_PPI = 300, scaleFor = (panel: ScreenPanel) => panel.ppi / BASE_PPI;
export const DEVICE_TYPESET = {
  kindle: {
    presets: [{ id: "narrow", label: "窄", px: 80 }, { id: "medium", label: "中", px: 137 }, { id: "wide", label: "宽", px: 220 }],
    top: 52, bottom: 70, emPx: 55, lineHeight: 1.75, measured: { model: "KPW3", margin: "narrow" },
    bookInsets: false, readerLineSpacingOverridesBook: false, sumAdjacentMargins: true, fontFamily: "serif",
    fallbackSources: ["Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", "Source Han Serif SC"].map(name => `local("${name}")`).join(", "),
    builtinFamilies: ["宋体", "黑体", "楷体", "圆体", "STSong", "STHeiti", "STKai", "STKaiti", "STYuan"],
  },
  kobo: {
    presets: [{ id: "min", label: "最小", px: 40 }],
    top: 96, bottom: 160, emPx: 53.5, lineHeight: 1.54, measured: { model: "libra2", margin: "min" },
    bookInsets: true, readerLineSpacingOverridesBook: true, sumAdjacentMargins: false, fontFamily: "sans-serif",
    fallbackSources: ["Microsoft YaHei", "Microsoft YaHei UI", "PingFang SC", "PingFangSC-Regular", "Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC", "WenQuanYi Micro Hei"].map(name => `local("${name}")`).join(", "),
    builtinFamilies: [] as string[],
  },
} as const;

export interface PreviewTarget { kind: DeviceKind; model: string; panelId: ScreenPanelId; panel: ScreenPanel; fallbackPanel: boolean }
export function previewTarget(kind: DeviceKind, model: string, panelId?: ScreenPanelId | null): PreviewTarget {
  const known = kind === "kindle" ? kindleModelInfo(model).panel : koboModelInfo(model).panel;
  const id = panelId ?? known ?? FALLBACK_PANELS[kind];
  return { kind, model, panelId: id, panel: SCREEN_PANELS[id], fallbackPanel: panelId === null || (panelId === undefined && known === null) };
}

export interface DevicePreset { id: string; label: string; px: number }
/** Device margin presets in device pixels for a panel; without one, the 300 ppi measurements. */
export function devicePresets(kind: DeviceKind, panel?: ScreenPanel): DevicePreset[] {
  const scale = panel ? scaleFor(panel) : 1;
  return DEVICE_TYPESET[kind].presets.map(preset => ({ ...preset, px: Math.round(preset.px * scale) }));
}

/** The built-in profile is shared by every device; a device remembers a profile by this id. */
export const DEFAULT_PROFILE_ID = "default";
export function profileIdInput(value: unknown): string {
  if (typeof value !== "string" || !/^[\w-]{1,128}$/.test(value)) throw new Error("无效的排版方案 ID");
  return value;
}

/** The device's own margin setting and remembered profile; font size and line spacing are previewed at the measured values. */
export interface DeviceReadingSettings { margin: string; profileId: string }
export function defaultReadingSettings(kind: DeviceKind): DeviceReadingSettings {
  return { margin: DEVICE_TYPESET[kind].presets[0].id, profileId: DEFAULT_PROFILE_ID };
}
/** Accepts stored or edited values; an unknown preset falls back to the measured default and an absent profile to the built-in one. */
export function readingSettings(kind: DeviceKind, raw: unknown): DeviceReadingSettings {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    margin: typeof value.margin === "string" && DEVICE_TYPESET[kind].presets.some(preset => preset.id === value.margin) ? value.margin : defaultReadingSettings(kind).margin,
    profileId: value.profileId === undefined ? DEFAULT_PROFILE_ID : profileIdInput(value.profileId),
  };
}

/**
 * A device page in device pixels; `fontFamily` is the reader's default face, still overridable by the book.
 * `bookInsets`: the reader keeps the book's own html/body margin and padding (Kobo), unlike boko for Kindle.
 * `sumAdjacentMargins`: Kindle adds adjacent sibling margins instead of collapsing them like a browser/Kobo.
 */
export interface PageGeometry {
  width: number; height: number; emPx: number; lineHeight: number; side: number; top: number; bottom: number; column: number; gap: number; contentHeight: number;
  baseEmPx?: number; measured?: boolean;
  fontFamily?: string; bookInsets?: boolean; embeddedFontsOnly?: boolean; readerLineSpacingOverridesBook?: boolean;
  sumAdjacentMargins?: boolean;
  fallbackSources?: string; builtinFamilies?: readonly string[];
}
export function pageGeometry(target: PreviewTarget, reading: DeviceReadingSettings): PageGeometry {
  const device = DEVICE_TYPESET[target.kind], scale = scaleFor(target.panel), normalized = readingSettings(target.kind, reading), margin = normalized.margin;
  const side = devicePresets(target.kind, target.panel).find(preset => preset.id === margin)!.px;
  const top = Math.round(device.top * scale), bottom = Math.round(device.bottom * scale);
  const baseEmPx = device.emPx * scale, emPx = baseEmPx;
  return {
    width: target.panel.width, height: target.panel.height, emPx, lineHeight: device.lineHeight, side, top, bottom,
    column: target.panel.width - 2 * side, gap: 2 * side, contentHeight: target.panel.height - top - bottom,
    baseEmPx, measured: target.model === device.measured.model && margin === device.measured.margin,
    fontFamily: device.fontFamily, bookInsets: device.bookInsets, embeddedFontsOnly: target.kind === "kobo",
    readerLineSpacingOverridesBook: device.readerLineSpacingOverridesBook, sumAdjacentMargins: device.sumAdjacentMargins,
    fallbackSources: device.fallbackSources, builtinFamilies: device.builtinFamilies,
  };
}

export function marginXPx(geometry: PageGeometry, marginX: number | null, unit: MarginXUnit): number {
  if (marginX === null) return 0;
  return unit === "percent" ? marginX / 100 * geometry.column : marginX * (geometry.baseEmPx ?? geometry.emPx);
}
/** The same physical margin in the other unit, at the baseline font size (scale 1). */
export function convertMarginX(geometry: PageGeometry, marginX: number, from: MarginXUnit, to: MarginXUnit): number {
  if (from === to) return marginX;
  const px = marginXPx(geometry, marginX, from), baseEmPx = geometry.baseEmPx ?? geometry.emPx;
  return to === "percent" ? px / geometry.column * 100 : px / baseEmPx;
}
export interface PreviewEstimate { sideMarginPx: number; contentWidthPx: number; charsPerLine: number; linesPerPage: number; measured: boolean }
/** CJK = 1em; excludes book-specific indentation, font sizing and custom CSS. */
export function previewEstimate(geometry: PageGeometry, settings: { marginX: number | null; marginXUnit: MarginXUnit }): PreviewEstimate {
  const sideMarginPx = geometry.side + marginXPx(geometry, settings.marginX, settings.marginXUnit);
  const contentWidthPx = Math.max(0, geometry.width - 2 * sideMarginPx);
  return { sideMarginPx, contentWidthPx, charsPerLine: Math.floor(contentWidthPx / geometry.emPx), linesPerPage: Math.floor(geometry.contentHeight / (geometry.emPx * geometry.lineHeight)), measured: geometry.measured === true };
}
