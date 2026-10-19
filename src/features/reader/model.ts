import { encodeEpubPath } from "../../core/epub-path";

export interface ReaderProgress { book_id: string; section: number; page: number; page_count: number; updated_at: string }
export interface SearchHit { index: number; title: string; offset: number; snippet: string }
export interface SearchResults { query: string; hits: SearchHit[]; indexed_sections: number; offset?: number; limit?: number; next_offset?: number; has_more?: boolean }
export interface ReaderData {
  book: { book_id: string; title: string; author: string | null; cover_url: string | null };
  sections: { title: string; item_path: string }[];
  section_index: number;
  initial_progress: ReaderProgress | null;
  return_to: string;
}

/** Remove fragments as in Python, and reject browser-normalized external paths. */
export function readerReturnTo(value: unknown, fallback = "/"): string {
  if (typeof value !== "string") return fallback;
  const raw = value.trim();
  if (!raw.startsWith("/") || raw.startsWith("//") || /[\\\x00-\x1f\x7f]/.test(raw)) return fallback;
  return raw.split("#")[0] || fallback;
}
export function sectionUrl(bookId: string, section: number, returnTo = "/", extra: Record<string, string> = {}): string {
  const query = new URLSearchParams();
  if (returnTo !== "/") query.set("return_to", returnTo);
  for (const [name, value] of Object.entries(extra)) if (value) query.set(name, value);
  return `/book/${bookId}/preview/${section}${query.size ? `?${query}` : ""}`;
}
export function contentUrl(bookId: string, path: string): string {
  return `/book/${bookId}/epub/${encodeEpubPath(path)}`;
}
export function initialPosition(data: ReaderData, query: URLSearchParams): { section: number; page: number } {
  let section = data.section_index, page = 1;
  const saved = data.initial_progress;
  if (query.get("resume") === "1" && saved && saved.section >= 0 && saved.section < data.sections.length) {
    section = saved.section; page = Math.max(1, saved.page);
  }
  if (["prev", "next"].includes(query.get("nav") || "")) page = 1;
  if (query.get("page") === "last" && !["prev", "next"].includes(query.get("nav") || "")) page = Number.MAX_SAFE_INTEGER;
  return { section, page };
}
export const pageEpsilon = 0.5;
export function textMatches(text: string, query: string, limit = 200): { start: number; end: number }[] {
  if (!query) return [];
  let lower = "", offset = 0;
  const starts: number[] = [], ends: number[] = [];
  for (const point of text) {
    const lowered = point.toLowerCase(); lower += lowered;
    for (let unit = 0; unit < lowered.length; unit++) { starts.push(offset); ends.push(offset + point.length); }
    offset += point.length;
  }
  const needle = query.toLowerCase(), matches: { start: number; end: number }[] = [];
  for (let at = 0; matches.length < limit;) {
    at = lower.indexOf(needle, at); if (at < 0) break;
    matches.push({ start: starts[at], end: ends[at + needle.length - 1] }); at += needle.length;
  }
  return matches;
}
export function highlightedParts(text: string, query: string): { text: string; matched: boolean }[] {
  const parts: { text: string; matched: boolean }[] = []; let offset = 0;
  for (const match of textMatches(text, query)) {
    if (match.start > offset) parts.push({ text: text.slice(offset, match.start), matched: false });
    parts.push({ text: text.slice(match.start, match.end), matched: true }); offset = match.end;
  }
  if (offset < text.length) parts.push({ text: text.slice(offset), matched: false });
  return parts;
}
export function pageMetrics(width: number, scrollWidth: number, left = 0) {
  const step = Math.max(1, width), maxLeft = Math.max(0, scrollWidth - width);
  const count = Math.max(1, Math.ceil((maxLeft - pageEpsilon) / step) + 1);
  const page = maxLeft - left <= pageEpsilon ? count : Math.min(count, Math.floor((left + pageEpsilon) / step) + 1);
  return { step, maxLeft, count, page };
}
export interface ReaderSettings {
  styleMode: "book" | "custom"; fontFamily: "serif" | "sans" | "kai" | "mono";
  fontSize: number; lineHeight: number; textAlignMode: "justify" | "left" | "center" | "right";
  pagePaddingX: number; pagePaddingY: number; readerBg: "book" | "paper" | "sand" | "mint" | "slate";
  brightnessMode: "bright" | "dim";
}
export const defaultSettings: ReaderSettings = { styleMode: "book", fontFamily: "serif", fontSize: 17, lineHeight: 1.85, textAlignMode: "justify", pagePaddingX: 9, pagePaddingY: 11, readerBg: "book", brightnessMode: "bright" };
export function normalizeSettings(raw: unknown): ReaderSettings {
  const result = { ...defaultSettings };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
  const value = raw as Record<string, unknown>;
  const choices = { styleMode: ["book", "custom"], fontFamily: ["serif", "sans", "kai", "mono"], textAlignMode: ["justify", "left", "center", "right"], readerBg: ["book", "paper", "sand", "mint", "slate"], brightnessMode: ["bright", "dim"] };
  for (const key of Object.keys(choices) as (keyof typeof choices)[]) {
    if (choices[key].includes(String(value[key]))) Object.assign(result, { [key]: value[key] });
  }
  for (const [key, min, max] of [["fontSize", 11, 28], ["lineHeight", 1.2, 2.4], ["pagePaddingX", -1, 48], ["pagePaddingY", -1, 48]] as const) {
    let number = typeof value[key] === "number" ? value[key] : parseFloat(String(value[key]));
    if (key === "lineHeight" && number <= 1.1) number += 1;
    if (Number.isFinite(number)) result[key] = Math.max(min, Math.min(max, key === "lineHeight" ? number : Math.trunc(number)));
  }
  return result;
}
