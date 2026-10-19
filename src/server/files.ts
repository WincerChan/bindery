import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { extname } from "node:path";
import { guessMediaType } from "../core/epub";
import { strip } from "../core/python";
import type { Metadata } from "../core/models";
import { coverPath, epubPath } from "./storage";
import { coverCacheHeaders, HttpError, requireBook } from "./http";
import { ensureBookEpubCss } from "./epub-css";
import { getLibrary } from "./runtime";

const coverMediaTypes: Record<string, string> = {
  ".avif": "image/avif", ".apng": "image/apng", ".bmp": "image/bmp",
  ".tif": "image/tiff", ".tiff": "image/tiff", ".ico": "image/vnd.microsoft.icon",
  ".jpe": "image/jpeg", ".jfif": "image/jpeg", ".heic": "image/heic", ".heif": "image/heif",
};

export function safeFilename(value: string): string {
  return value.replace(/[^0-9a-zA-Z\u4e00-\u9fff]+/g, "_").replace(/^_+|_+$/g, "") || "book";
}
export function downloadFilename(meta: Pick<Metadata, "title" | "author">): string {
  return `${safeFilename(strip(meta.title || ""))}-${safeFilename(strip(meta.author || "") || "未知")}.epub`;
}

export function fileResponse(request: Request, path: string, options: { type?: string; filename?: string; headers?: HeadersInit } = {}): Response {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new HttpError(404, "资源不存在");
  const etag = `"${createHash("md5").update(`${stat.mtimeMs / 1000}-${stat.size}`).digest("hex")}"`;
  const modified = stat.mtime.toUTCString();
  const headers = new Headers(options.headers);
  headers.set("Content-Type", options.type || coverMediaTypes[extname(path).toLowerCase()] || guessMediaType(path));
  headers.set("Content-Length", String(stat.size));
  headers.set("Last-Modified", modified);
  headers.set("ETag", etag);
  headers.set("Accept-Ranges", "bytes");
  if (options.filename) {
    const name = options.filename;
    headers.set("Content-Disposition", /^[\w. -]+$/.test(name)
      ? `attachment; filename="${name}"`
      : `attachment; filename*=utf-8''${encodeURIComponent(name).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`);
  }
  const noneMatch = request.headers.get("If-None-Match");
  if (noneMatch ? noneMatch.split(",").some(e => e.trim().replace(/^W\//, "") === etag || e.trim() === "*")
    : request.headers.has("If-Modified-Since") && Date.parse(request.headers.get("If-Modified-Since")!) >= Math.floor(stat.mtimeMs / 1000) * 1000) {
    headers.delete("Content-Length");
    return new Response(null, { status: 304, headers });
  }
  let start = 0, end = stat.size - 1, status = 200;
  const range = request.headers.get("Range"), ifRange = request.headers.get("If-Range");
  // Ignore unsupported multi-range requests; single and suffix ranges stream directly.
  if (range && !range.includes(",") && (!ifRange || ifRange === etag || ifRange === modified)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(end, Number(match[2])) : end;
      if (start > end || start >= stat.size || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
        headers.set("Content-Range", `bytes */${stat.size}`);
        headers.set("Content-Length", "0");
        return new Response(null, { status: 416, headers });
      }
      status = 206;
      headers.set("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      headers.set("Content-Length", String(end - start + 1));
    }
  }
  const body = request.method === "HEAD" || !stat.size ? null : Readable.toWeb(createReadStream(path, { start, end, signal: request.signal })) as ReadableStream<Uint8Array>;
  return new Response(body, { status, headers });
}

export function bookCoverResponse(request: Request, bookId: string, library = getLibrary()): Response {
  const meta = requireBook(bookId, library);
  if (!meta.cover_file) throw new HttpError(404, "封面不存在");
  const path = coverPath(library.base, bookId, meta.cover_file);
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) throw new HttpError(404, "封面不存在");
  return fileResponse(request, path, { headers: coverCacheHeaders() });
}
export function bookDownloadResponse(request: Request, bookId: string, library = getLibrary()): Response {
  const meta = requireBook(bookId, library);
  ensureBookEpubCss(meta, library);
  const path = epubPath(library.base, bookId);
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) throw new HttpError(404, "EPUB 不存在");
  return fileResponse(request, path, { type: "application/epub+zip", filename: downloadFilename(meta) });
}
