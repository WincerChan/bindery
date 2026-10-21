import { inspectFont, isFontFile, type DeviceFont, type FontFamily } from "../../../client/kindle/fonts";
import { KINDLE_MODELS, type KindleModel } from "../../../client/kindle/identity";
import type { EpubStripOptions } from "../../../core/epub-strip";
import { encodeEpubPath } from "../../../core/epub-path";

export interface PreviewBook { id: string; title: string; author: string | null }
export interface PreviewChapter { title: string; item_path: string }
export interface PreviewData { books: PreviewBook[]; bookId: string; sections: PreviewChapter[]; error: string }
export function previewContentUrl(bookId: string, path: string, options: EpubStripOptions): string {
  const member = encodeEpubPath(path);
  return options.stripFonts || options.stripImages
    ? `/devices/content/${bookId}/${options.stripFonts ? 1 : 0}${options.stripImages ? 1 : 0}/epub/${member}`
    : `/book/${bookId}/epub/${member}`;
}
export function screenFor(model: KindleModel) { return KINDLE_MODELS[model === "other" ? "KPW3" : model]; }

/** Measure without the end spacer. Ceil the extent, never add a page to an exact multiple. */
export function previewPagination(width: number, extent: number, desiredPage = 1) {
  const step = Math.max(1, Math.round(width));
  const count = Math.max(1, Math.ceil(Math.round(extent) / step));
  const page = Math.max(1, Math.min(count, Math.trunc(desiredPage)));
  return { step, count, page, left: (page - 1) * step, end: count * step };
}
export function previewAnchorPage(left: number, scrollLeft: number, step: number) {
  // Range coordinates are viewport-relative; negative profile margins still belong to this page.
  return Math.max(1, Math.floor((left + scrollLeft + 0.5) / step) + 1);
}
export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes >= 1024 ** 3 ? 3 : bytes >= 1024 ** 2 ? 2 : 1;
  return `${(bytes / 1024 ** unit).toFixed(1)} ${["B", "KB", "MB", "GB"][unit]}`;
}
export function groupFonts(fonts: DeviceFont[]): FontFamily[] {
  const families = new Map<string, FontFamily>();
  for (const font of fonts) {
    const family = families.get(font.family) ?? { name: font.family, fonts: [], coverage: [], size: 0 };
    family.fonts.push(font); family.size += font.size;
    if (!family.coverage.includes(font.coverage)) family.coverage.push(font.coverage);
    families.set(family.name, family);
  }
  return [...families.values()];
}
/** Inspect the entire batch before offering a write; never silently discard unsupported files. */
export async function inspectFontBatch(files: File[]) {
  if (!files.length) throw new Error("请选择 TTF 或 OTF 字体文件");
  const names = new Set<string>();
  for (const file of files) {
    if (!isFontFile(file.name)) throw new Error(`只支持 TTF 和 OTF 字体文件：${file.name}`);
    const key = file.name.toLowerCase();
    if (names.has(key)) throw new Error(`重复的字体文件名：${file.name}`);
    names.add(key);
  }
  return groupFonts(await Promise.all(files.map(inspectFont)));
}
