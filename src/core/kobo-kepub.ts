import { appendProfileCss } from "./epub-profile-css";
import { sanitizeEpubMemberPaths } from "./epub-safe-paths";
import { stripEpubAssets, type EpubStripOptions } from "./epub-strip";
import { convertToKepubAsync, type KepubOptions, type KepubResult } from "./kepub";

export interface KoboProfile { settings: EpubStripOptions; css: string }
export interface KoboConversionOptions extends KepubOptions, EpubStripOptions { profile?: KoboProfile }

/**
 * Kobo's device pipeline: optional font/image/page-margin stripping, profile CSS, FAT-safe member names, then KEPUB.
 * Each pre-step writes an uncompressed intermediate archive and the converter deflates it once, so a plain EPUB
 * still reaches the converter untouched and keeps kepubify parity.
 */
export async function convertForKobo(data: Uint8Array, options: KoboConversionOptions = {}): Promise<KepubResult> {
  if (options.signal?.aborted) throw new DOMException("操作已取消", "AbortError");
  options.progress?.("inspecting");
  const settings = options.profile?.settings ?? { stripFonts: options.stripFonts, stripImages: options.stripImages, stripPageMargins: options.stripPageMargins };
  const css = options.profile?.css ?? "";
  const strip = Boolean(settings.stripFonts || settings.stripImages || settings.stripPageMargins), cssAdded = Boolean(css.trim());
  let working = data;
  if (strip) working = stripEpubAssets(working, settings, null);
  if (cssAdded) working = appendProfileCss(working, css, null);
  const safe = sanitizeEpubMemberPaths(working);
  return convertToKepubAsync(safe.data, { signal: options.signal, progress: options.progress, compressStored: strip || cssAdded || safe.changed });
}
