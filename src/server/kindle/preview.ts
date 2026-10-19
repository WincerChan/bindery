import { epubBaseHref, loadEpubItem } from "../../core/epub";
import { stripEpubAssets } from "../../core/epub-strip";
import { HttpError, requireBook } from "../http";
import { isolatedBookHtml, validateItemPath } from "../reader/resources";
import { readBookEpub } from "../reader/service";
import type { LibraryStorage } from "../storage";

/** A read-only preview of the same copy transformation used before conversion. */
export function kindlePreviewResource(request: Request, bookId: string, mode: string, rawPath: string, library: LibraryStorage): Response {
  requireBook(bookId, library);
  if (!/^[01]{2}$/.test(mode)) throw new HttpError(404, "资源不存在");
  const path = validateItemPath(rawPath), prefix = `/kindle/content/${bookId}/${mode}/epub/`;
  const copy = stripEpubAssets(readBookEpub(bookId, library), { stripFonts: mode[0] === "1", stripImages: mode[1] === "1" });
  let content: Uint8Array, media: string;
  try { [content, media] = loadEpubItem(copy, path, epubBaseHref(prefix, path)); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("File not found:")) throw new HttpError(404, "资源不存在");
    throw error;
  }
  if (media.toLowerCase().includes("html")) {
    content = new TextEncoder().encode(isolatedBookHtml(content, epubBaseHref(prefix, path), request.url));
    media = "text/html; charset=utf-8";
  } else if (media.startsWith("text/")) media += "; charset=utf-8";
  const source = new URL(prefix, request.url).href;
  return new Response(request.method === "HEAD" ? null : content as BodyInit, { headers: {
    "Cache-Control": "no-store", "Content-Type": media, "Content-Length": String(content.byteLength),
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": `sandbox allow-same-origin; default-src 'none'; script-src 'none'; style-src 'unsafe-inline' ${source}; img-src data: ${source}; font-src data: ${source}; object-src 'none'; frame-src 'none'; connect-src 'none'; form-action 'none'; base-uri ${source}; frame-ancestors 'self'`,
  } });
}
