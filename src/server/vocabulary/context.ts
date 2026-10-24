import type { VocabularyContext } from "./input";
import { vocabularyPattern } from "../../core/vocabulary";
import type { LibraryStorage } from "../storage";
import { readBookArchive } from "../reader/service";
import { unescapeSearchHtml } from "../reader/entities";

export interface SentenceSpan { text: string; start: number; end: number }
export interface BookText { text: string; sections: Array<{ start: number; end: number }>; sentences: SentenceSpan[] }
export interface StoredVocabularyContext extends VocabularyContext { offset?: number }

const BLOCK = "address|article|aside|blockquote|body|caption|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hr|html|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul";
const blockClose = new RegExp(`</(?:${BLOCK})\\s*>`, "gi");
const blockOpen = new RegExp(`<(?:${BLOCK})\\b[^>]*>`, "gi");
const spaces = /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu;

/** Block tags and <br> become line boundaries so sentences never run across paragraphs. */
export function bookHtmlText(content: Uint8Array): string {
  const html = new TextDecoder("utf-8", { ignoreBOM: true }).decode(content)
    .replace(/<script\b[^>]*>.*?<\/script>/gis, " ")
    .replace(/<style\b[^>]*>.*?<\/style>/gis, " ")
    .replace(/<br\b[^>]*\/?>/gi, "\n");
  const text = unescapeSearchHtml(html.replace(blockClose, "\n").replace(blockOpen, "\n").replace(/<[^>]+>/gs, " "));
  return text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u)
    .map(line => line.replace(spaces, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sentenceSpans(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  // Keep punctuation and closing quotes with the sentence; a line/block boundary always ends one.
  const pattern = /[^.!?。？！…\n]+(?:[.!?。？！…]+[\p{Pe}\p{Pf}"'”’」』】）)]*)?/gu;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0], leading = raw.length - raw.trimStart().length;
    const value = raw.trim();
    if (!value) continue;
    const start = (match.index ?? 0) + leading;
    spans.push({ text: value, start, end: start + value.length });
  }
  return spans;
}

export function readBookText(library: LibraryStorage, bookId: string): BookText {
  const archive = readBookArchive(bookId, library), { documents } = archive.metadata(), parts: string[] = [], sections: Array<{ start: number; end: number }> = [];
  let length = 0;
  for (const document of documents) {
    if (!document.media_type.toLowerCase().includes("html")) { sections.push({ start: length, end: length }); continue; }
    const content = archive.read(document.member_path);
    const text = content ? bookHtmlText(content) : "";
    if (text && parts.length) { parts.push("\n\n"); length += 2; }
    const start = length;
    parts.push(text);
    length += text.length;
    sections.push({ start, end: length });
  }
  const text = parts.join("");
  return { text, sections, sentences: sentenceSpans(text) };
}

export function wordOffsets(book: BookText, word: string): number[] {
  const pattern = vocabularyPattern(word), offsets: number[] = [];
  for (const match of book.text.matchAll(pattern)) offsets.push(match.index ?? 0);
  return offsets;
}

export function contextAt(book: BookText, offset: number): StoredVocabularyContext {
  const spans = book.sentences;
  let index = spans.findIndex(span => offset >= span.start && offset < span.end);
  if (index < 0) index = spans.findIndex(span => span.start > offset);
  if (index < 0) index = spans.length - 1;
  if (index < 0) return { sentence: "", previous: [], following: [], offset };
  const text = (span: SentenceSpan) => span.text.slice(0, 8192);
  return {
    sentence: spans[index]!.text.slice(0, 2000),
    previous: spans.slice(Math.max(0, index - 2), index).map(text),
    following: spans.slice(index + 1, index + 3).map(text),
    offset,
  };
}

function contextOffset(book: BookText, context: StoredVocabularyContext | null, word: string): number | null {
  if (!context) return null;
  if (typeof context.offset === "number" && Number.isFinite(context.offset)) return context.offset;
  const wanted = context.sentence.slice(0, 2000);
  for (const offset of wordOffsets(book, word)) if (contextAt(book, offset).sentence === wanted) return offset;
  return null;
}

function readingBound(library: LibraryStorage, book: BookText, bookId: string, deviceId: string): number | null {
  const row = library.db.listDeviceReading(bookId).find(item => item.device_id === deviceId);
  if (!row) return null;
  if (row.section !== null && row.section >= 0 && row.section < book.sections.length) {
    const section = book.sections[row.section]!, fraction = Math.max(0, Math.min(1, row.section_fraction ?? 0));
    return section.start + (section.end - section.start) * fraction;
  }
  return typeof row.percent === "number" && Number.isFinite(row.percent) ? book.text.length * Math.max(0, Math.min(100, row.percent)) / 100 : null;
}

/** Persist one context per Kobo word; rows without a book stay pending and can be retried later. */
export function computeKoboContexts(library: LibraryStorage, deviceId: string, bookIds: readonly string[], now: string): void {
  for (const bookId of new Set(bookIds)) {
    const rows = library.db.listVocabularyForBookDevice(bookId, deviceId);
    if (!rows.some(row => row.context_json === null)) continue;
    let book: BookText;
    try { book = readBookText(library, bookId); }
    catch { continue; }
    const bound = readingBound(library, book, bookId, deviceId);
    let previous = -1;
    for (const row of rows) {
      const existing = row.context_json ? JSON.parse(row.context_json) as StoredVocabularyContext : null;
      if (existing) {
        previous = contextOffset(book, existing, row.word) ?? previous;
        continue;
      }
      const candidates = wordOffsets(book, row.word);
      let selected: number | null = null;
      if (candidates.length === 1) selected = candidates[0]!;
      else if (candidates.length > 1) {
        selected = candidates.find(offset => offset > previous && (bound === null || offset <= bound)) ?? candidates[0]!;
      }
      if (selected === null) {
        library.db.updateVocabularyContext(row.id, JSON.stringify({ sentence: "", previous: [], following: [] }), "not_found", now);
        continue;
      }
      const context = contextAt(book, selected);
      library.db.updateVocabularyContext(row.id, JSON.stringify(context), "found", now);
      previous = selected;
    }
  }
}
