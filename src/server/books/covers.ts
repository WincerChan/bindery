import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { Metadata } from "../../core/models";
import { buildEpub, extractCover, updateEpubMetadata } from "../../core/epub";
import { composeBookCss } from "../epub-css";
import { requireBook, HttpError } from "../http";
import {
  coverPath,
  epubPath,
  saveCoverBytes,
  saveBook,
  sourcePath,
  type LibraryStorage,
} from "../storage";
import { nowIso } from "../db";
import { getRule } from "../templates";
import { parseBookFile } from "../parsing";
import { USER_AGENT, type Fetch } from "./metadata-lookup";

// Python has no cover limits. Explicit bounds prevent unbounded form/remote allocations.
export const MAX_COVER_BYTES = 20 * 1024 * 1024;
export function validateCover(data: Uint8Array): void {
  if (!data.length) throw new HttpError(400, "Empty cover");
  if (data.length > MAX_COVER_BYTES)
    throw new HttpError(413, "封面文件过大（最多 20 MiB）");
  const b = Buffer.from(data);
  if (!(
    b.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
    b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
    ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString()) ||
    (b.subarray(0, 4).toString() === "RIFF" &&
      b.subarray(8, 12).toString() === "WEBP") ||
    b
      .toString("utf8", 0, 256)
      .trimStart()
      .match(/^(?:<\?xml[^>]*>\s*)?<svg[\s>]/i)
  ))
    throw new HttpError(
      415,
      "不支持的封面类型（支持 JPEG、PNG、GIF、WebP、SVG）",
    );
}
export async function uploadedCover(file: File): Promise<Uint8Array> {
  if (file.size > MAX_COVER_BYTES)
    throw new HttpError(413, "封面文件过大（最多 20 MiB）");
  const data = new Uint8Array(await file.arrayBuffer());
  validateCover(data);
  return data;
}
export async function downloadCoverFromUrl(
  raw: string,
  fetcher: Fetch = fetch,
  timeout = 10,
): Promise<{ data: Uint8Array; filename: string }> {
  const url = raw.trim();
  if (!url) throw new HttpError(400, "Missing URL");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, "封面 URL 无效");
  }
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new HttpError(400, "封面 URL 仅支持 HTTP 或 HTTPS");
  const douban = /(^|\.)douban(?:io)?\.com$/i.test(parsed.hostname),
    headers: Record<string, string> = douban
      ? {
          Referer: "https://book.douban.com/",
          "User-Agent": USER_AGENT,
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        }
      : {};
  let response: Response;
  try {
    response = await fetcher(url, {
      headers,
      signal: AbortSignal.timeout(timeout * 1000),
    });
  } catch (error) {
    throw new HttpError(
      400,
      `${douban ? "豆瓣" : ""}封面下载失败（网络异常）: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(
      400,
      `${douban ? "豆瓣" : ""}封面下载失败（HTTP ${response.status}）: ${url}`,
    );
  }
  if (Number(response.headers.get("content-length")) > MAX_COVER_BYTES) {
    await response.body?.cancel();
    throw new HttpError(413, "封面文件过大（最多 20 MiB）");
  }
  const reader = response.body?.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_COVER_BYTES) {
          await reader.cancel();
          throw new HttpError(413, "封面文件过大（最多 20 MiB）");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (!size) throw new HttpError(400, "封面 URL 下载为空");
  return {
    data: Buffer.concat(chunks),
    filename: basename(parsed.pathname) || "cover",
  };
}
export function writeBookEpub(
  meta: Metadata,
  library: LibraryStorage,
  options: { strip_original_css?: boolean } = {},
): void {
  const path = epubPath(library.base, meta.book_id),
    cover = meta.cover_file
      ? {
          name: meta.cover_file,
          data: readFileSync(
            coverPath(library.base, meta.book_id, meta.cover_file),
          ),
        }
      : null,
    css_text = composeBookCss(meta);
  let book: ReturnType<typeof parseBookFile> | undefined;
  let data: Uint8Array;
  if (
    meta.source_type !== "epub" &&
    existsSync(sourcePath(library.base, meta.book_id))
  ) {
    book = parseBookFile(
      sourcePath(library.base, meta.book_id),
      meta.book_id,
      getRule(meta.rule_template || "default")?.rules,
    );
    data = buildEpub(book, meta, { cover, css_text });
  } else {
    if (!existsSync(path)) throw new HttpError(404, "EPUB 不存在");
    data = updateEpubMetadata(readFileSync(path), meta, {
      cover,
      css_text,
      strip_original_css: options.strip_original_css,
    });
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, data);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  if (book) saveBook(book, library.base, meta.book_id);
  meta.status = "synced";
  meta.updated_at = meta.epub_updated_at = nowIso();
  library.saveMetadata(meta);
}
export function replaceCover(
  id: string,
  data: Uint8Array,
  _filename: string,
  library: LibraryStorage,
): void {
  const meta = requireBook(id, library);
  validateCover(data);
  // Select extension by actual bytes, so a remote .html path cannot produce a mismatched MIME.
  meta.cover_file = saveCoverBytes(library.base, id, data, null);
  meta.updated_at = nowIso();
  library.saveMetadata(meta);
  writeBookEpub(meta, library);
}
export function extractBookCover(id: string, library: LibraryStorage): void {
  requireBook(id, library);
  const path = epubPath(library.base, id);
  if (!existsSync(path)) throw new HttpError(404, "EPUB 不存在");
  const result = extractCover(readFileSync(path));
  if (!result) throw new HttpError(404, "No cover in EPUB");
  replaceCover(id, result[0], result[1], library);
}
