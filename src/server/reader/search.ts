import type { EpubSectionDocument } from "../../core/epub";
import { requireBook, HttpError } from "../http";
import type { LibraryStorage } from "../storage";
import type { SearchResults, SearchHit } from "../../features/reader/model";
import { readBookArchive } from "./service";
import { unescapeSearchHtml } from "./entities";
import { bigIntegerParameter, integerParameter } from "./parameters";

// Python re's Unicode whitespace also includes U+001C–001F and U+0085, excludes FEFF.
export const normalizeSearchText = (value: string): string => value.replace(/[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu, " ").replace(/^ +| +$/g, "");
export function extractSearchText(content: Uint8Array): string {
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(content)
    .replace(/<script\b[^>]*>.*?<\/script>/gis, " ").replace(/<style\b[^>]*>.*?<\/style>/gis, " ").replace(/<[^>]+>/gs, " ");
  return normalizeSearchText(unescapeSearchHtml(text));
}
export function searchDocuments(documents: Iterable<EpubSectionDocument>, query: string, limit: number, offset = 0) {
  const hits: SearchHit[] = [];
  let indexed_sections = 0, matches = 0, has_more = false;
  const normalized = normalizeSearchText(query), lower = normalized.toLowerCase();
  if (!normalized) return { hits, indexed_sections, has_more, next_offset: 0 };
  for (const section of documents) {
    if (!section.media_type.toLowerCase().includes("html")) continue;
    const text = extractSearchText(section.content);
    if (!text) continue;
    indexed_sections++;
    // Python indexes Unicode code points, including astral characters.
    const textLower = text.toLowerCase(), atUnits = textLower.indexOf(lower);
    if (atUnits < 0 || ++matches <= offset) continue;
    const at = Array.from(textLower.slice(0, atUnits)).length;
    const points = Array.from(text), start = Math.max(0, at - 30), end = Math.min(points.length, at + Array.from(normalized).length + 70);
    if (hits.length < limit) hits.push({ index: section.index, title: section.title, offset: at, snippet: (start ? "..." : "") + points.slice(start, end).join("") + (end < points.length ? "..." : "") });
    else has_more = true;
  }
  return { hits, indexed_sections, has_more, next_offset: offset + hits.length };
}
export function searchBook(request: Request, bookId: string, library: LibraryStorage): Response {
  requireBook(bookId, library);
  const params = new URL(request.url).searchParams, raw = params.get("q") || "";
  const integer = (name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) => {
    const rawValue = params.get(name);
    const value = rawValue === null ? fallback : integerParameter(rawValue);
    if (value === null || value < min || value > max) throw new HttpError(422, "请求参数无效");
    return value;
  };
  if (Array.from(raw).length > 200) throw new HttpError(422, "请求参数无效");
  const limit = integer("limit", 10, 1, 100), rawOffset = bigIntegerParameter(params.get("offset") ?? "0"), query = normalizeSearchText(raw);
  if (rawOffset === null || rawOffset < 0) throw new HttpError(422, "请求参数无效");
  if (!query) return Response.json({ query: "", hits: [], indexed_sections: 0 } satisfies SearchResults);
  const offset = Number(rawOffset > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : rawOffset);
  const archive = readBookArchive(bookId, library), { sections, documents } = archive.metadata();
  function* spine(): Generator<EpubSectionDocument> {
    for (let index = 0; index < documents.length; index++) {
      const content = archive.read(documents[index].member_path);
      if (content) yield { ...sections[index], index, content, media_type: documents[index].media_type };
    }
  }
  const result = searchDocuments(spine(), query, limit, offset);
  if (rawOffset > Number.MAX_SAFE_INTEGER) {
    // Preserve Python's unbounded offset on the wire; no EPUB can have 2^53 sections.
    const { next_offset: _next, ...details } = result;
    const payload = JSON.stringify({ query, ...details, limit });
    return new Response(`${payload.slice(0, -1)},"offset":${rawOffset},"next_offset":${rawOffset + BigInt(result.hits.length)}}`, { headers: { "Content-Type": "application/json" } });
  }
  return Response.json({ query, ...result, offset, limit } satisfies SearchResults);
}
