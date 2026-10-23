import { KINDLE_MODELS, type KindleModel } from "../../../client/kindle/identity";
import type { EpubStripOptions } from "../../../core/epub-strip";
import { encodeEpubPath } from "../../../core/epub-path";

export interface PreviewBook { id: string; title: string; author: string | null }
export interface PreviewChapter { title: string; item_path: string }
export interface PreviewData { books: PreviewBook[]; bookId: string; sections: PreviewChapter[]; error: string }
export function previewContentUrl(bookId: string, path: string, options: EpubStripOptions): string {
  const member = encodeEpubPath(path);
  // Fixed five flags: fonts, images, page margins, line height and paragraph spacing.
  const flags = [options.stripFonts, options.stripImages, options.stripPageMargins, options.stripLineHeight, options.stripParagraphSpacing];
  const mode = flags.map(flag => flag ? "1" : "0").join("");
  return flags.some(Boolean)
    ? `/devices/content/${bookId}/${mode}/epub/${member}`
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
