import { sanitizeEpubMemberPaths } from "./epub-safe-paths";
import { stripEpubAssets, type EpubStripOptions } from "./epub-strip";
import { convertToKepubAsync, type KepubOptions, type KepubResult } from "./kepub";

/**
 * Kobo's device pipeline: optional font/image/page-margin stripping, FAT-safe member names, then KEPUB.
 * Each pre-step writes an uncompressed intermediate archive and the converter deflates it once, so a
 * plain EPUB still reaches the converter untouched and keeps kepubify parity.
 */
export async function convertForKobo(data: Uint8Array, options: KepubOptions & EpubStripOptions = {}): Promise<KepubResult> {
  if (options.signal?.aborted) throw new DOMException("操作已取消", "AbortError");
  options.progress?.("inspecting");
  const strip = Boolean(options.stripFonts || options.stripImages || options.stripPageMargins);
  const stripped = strip ? stripEpubAssets(data, { stripFonts: options.stripFonts, stripImages: options.stripImages, stripPageMargins: options.stripPageMargins }, null) : data;
  const safe = sanitizeEpubMemberPaths(stripped);
  return convertToKepubAsync(safe.data, { signal: options.signal, progress: options.progress, compressStored: strip || safe.changed });
}
