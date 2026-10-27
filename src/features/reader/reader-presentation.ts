import { defaultSettings, type ReaderSettings } from "./model";

/** New readers get v2 typography; saved objects still use the existing validator. */
export function readerInitialSettings(phone = false): ReaderSettings {
  return { ...defaultSettings, styleMode: "custom", fontSize: phone ? 19 : 21, lineHeight: phone ? 2 : 2.1, pagePaddingX: phone ? 24 : 40, pagePaddingY: phone ? 0 : 24, readerBg: "paper" };
}

/** Retain legacy persisted palette keys, but present them through the three v2 papers. */
export function readerPaper(settings: ReaderSettings): "paper" | "white" | "dark" {
  return settings.brightnessMode === "dim" ? "dark" : settings.readerBg === "book" || settings.readerBg === "slate" ? "white" : "paper";
}

/** Saved pages depend on the layout they were measured in (columns, font size, viewport);
 * resume by position within the section so a different layout keeps the reading place. */
export function resumeFraction(page: number, pageCount: number, fraction?: number): number | undefined {
  if (fraction !== undefined) return fraction;
  return pageCount > 1 ? (Math.max(1, Math.min(page, pageCount)) - 1) / (pageCount - 1) : undefined;
}

/** Chapter-weighted estimate, like reading history; no invented whole-book page total. */
export function readerPercent(section: number, page: number, pageCount: number, sectionCount: number) {
  const fraction = pageCount <= 1 ? 1 : (page - 1) / (pageCount - 1);
  return Math.max(0, Math.min(100, (section + fraction) / Math.max(1, sectionCount) * 100));
}
export function readerProgressTarget(percent: number, sectionCount: number) {
  const count = Math.max(1, sectionCount), position = Math.max(0, Math.min(100, percent)) / 100 * count;
  const section = Math.min(count - 1, Math.floor(position));
  return { section, fraction: position - section };
}
