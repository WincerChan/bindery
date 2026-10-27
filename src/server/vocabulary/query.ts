import type { VocabularyRow } from "../db";
import { HttpError } from "../http";
import type { LibraryStorage } from "../storage";
import type { VocabularyContext } from "./input";

export type PushState = "pending" | "pushed" | "conflict" | "error";
export interface VocabularyPushStatus { status?: string; http?: number; category?: string; attempts?: number; retryable?: boolean; next_attempt_at?: string }
export interface VocabularyItem {
  id: string;
  word: string;
  raw_word: string;
  lang: string | null;
  book_id: string | null;
  book_key: string;
  book_title: string;
  source_title: string;
  device_id: string;
  device_kind: string;
  device_name: string;
  looked_up_at: string;
  context: VocabularyContext;
  context_state: string;
  push_state: PushState;
  push_status: VocabularyPushStatus | null;
  pushed_at: string | null;
}
export interface VocabularyChoice { key: string; label: string; count: number }
export interface VocabularySummary {
  total: number;
  month: { since: string; count: number; top_source: { title: string; book_id: string | null; count: number } | null };
  push: { pushed: number; failed: number; pending: number };
  latest: Pick<VocabularyItem, "id" | "word" | "raw_word" | "book_title" | "book_id" | "device_name" | "looked_up_at" | "context"> | null;
}
export interface VocabularyPage {
  summary: VocabularySummary;
  items: VocabularyItem[];
  devices: VocabularyChoice[];
  books: VocabularyChoice[];
  totals: { all: number; pending: number; pushed: number; conflict: number; error: number };
}
export interface VocabularyQuery { deviceId?: string; bookId?: string; pushState?: PushState; query?: string; month_start?: string }
const PUSH_STATES = new Set(["pending", "pushed", "conflict", "error"]);

function monthStart(value: unknown): string | undefined {
  // Require a complete, timezone-qualified instant, not Date.parse's permissive
  // date-only/local-time formats or its rollover of impossible calendar dates.
  if (typeof value !== "string" || value.length > 64) return undefined;
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  // Round-trip the written calendar date in UTC, independent of its offset.
  const date = value.slice(0, 10);
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return undefined;
  const normalized = new Date(parsed).toISOString();
  return normalized.length === 24 ? normalized : undefined;
}

export function vocabularyQuery(value: unknown): VocabularyQuery {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(422, "生词筛选条件无效");
  const input = value as Record<string, unknown>, result: VocabularyQuery = {};
  if (typeof input.deviceId === "string" && input.deviceId) {
    if (!/^[\w-]{1,128}$/.test(input.deviceId)) throw new HttpError(422, "生词筛选条件无效");
    result.deviceId = input.deviceId;
  }
  if (typeof input.bookId === "string" && input.bookId) {
    if (input.bookId.length > 300) throw new HttpError(422, "生词筛选条件无效");
    result.bookId = input.bookId;
  }
  if (typeof input.pushState === "string" && input.pushState) {
    if (!PUSH_STATES.has(input.pushState)) throw new HttpError(422, "生词筛选条件无效");
    result.pushState = input.pushState as PushState;
  }
  if (typeof input.query === "string" && input.query) {
    if (input.query.length > 200) throw new HttpError(422, "生词筛选条件无效");
    result.query = input.query;
  }
  const since = monthStart(input.month_start);
  if (since) result.month_start = since;
  return result;
}
function parseContext(value: string | null): VocabularyContext {
  if (!value) return { sentence: "", previous: [], following: [] };
  try {
    const context = JSON.parse(value) as Record<string, unknown>;
    const list = (items: unknown) => Array.isArray(items) ? items.filter((item): item is string => typeof item === "string") : [];
    return {
      sentence: typeof context.sentence === "string" ? context.sentence : "",
      previous: list(context.previous),
      following: list(context.following),
    };
  } catch { return { sentence: "", previous: [], following: [] }; }
}
function parseStatus(value: string | null): VocabularyPushStatus | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const row = parsed as Record<string, unknown>, status: VocabularyPushStatus = {};
    if (typeof row.status === "string") status.status = row.status;
    if (typeof row.http === "number" && Number.isFinite(row.http)) status.http = row.http;
    if (typeof row.category === "string") status.category = row.category;
    if (typeof row.attempts === "number" && Number.isFinite(row.attempts)) status.attempts = row.attempts;
    if (typeof row.retryable === "boolean") status.retryable = row.retryable;
    if (typeof row.next_attempt_at === "string") status.next_attempt_at = row.next_attempt_at;
    return status;
  } catch { return null; }
}
function bookTitle(library: LibraryStorage, bookId: string | null, sourceTitle: string, titles: Map<string, string>): string {
  if (!bookId) return sourceTitle;
  if (!titles.has(bookId)) {
    try { titles.set(bookId, library.loadMetadata(bookId).title || sourceTitle); }
    catch { titles.set(bookId, sourceTitle); }
  }
  return titles.get(bookId) || sourceTitle;
}
function view(library: LibraryStorage, row: VocabularyRow, titles: Map<string, string>): VocabularyItem {
  const push = PUSH_STATES.has(row.push_state) ? row.push_state as PushState : "pending";
  return {
    id: row.id,
    word: row.word,
    raw_word: row.raw_word,
    lang: row.lang,
    book_id: row.book_id,
    book_key: row.book_id ?? `title:${row.source_title}`,
    book_title: bookTitle(library, row.book_id, row.source_title, titles),
    source_title: row.source_title,
    device_id: row.device_id,
    device_kind: row.device_kind,
    device_name: row.device_name,
    looked_up_at: row.looked_up_at,
    context: parseContext(row.context_json),
    context_state: row.context_state,
    push_state: push,
    push_status: parseStatus(row.push_status_json),
    pushed_at: row.pushed_at,
  };
}
function countChoices(rows: readonly VocabularyItem[], key: (item: VocabularyItem) => string, label: (item: VocabularyItem) => string): VocabularyChoice[] {
  const choices = new Map<string, VocabularyChoice>();
  for (const item of rows) {
    const choiceKey = key(item), current = choices.get(choiceKey);
    if (current) current.count++;
    else choices.set(choiceKey, { key: choiceKey, label: label(item), count: 1 });
  }
  return [...choices.values()].sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
}
function vocabularySummary(library: LibraryStorage, titles: Map<string, string>, month_start?: string): VocabularySummary {
  const now = new Date(), since = month_start ?? new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const { total, pushed, failed, pending } = library.db.vocabularyCounts();
  const month = library.db.vocabularyMonth(since), row = library.db.latestVocabulary();
  const latest = row ? view(library, row, titles) : null, source = month.top_source;
  return {
    total,
    month: { since, count: month.count, top_source: source ? {
      ...source, title: bookTitle(library, source.book_id, source.title, titles),
    } : null },
    push: { pushed, failed, pending },
    latest: latest ? {
      id: latest.id,
      word: latest.word,
      raw_word: latest.raw_word,
      book_title: latest.book_title,
      book_id: latest.book_id,
      device_name: latest.device_name,
      looked_up_at: latest.looked_up_at,
      context: latest.context,
    } : null,
  };
}
export function listVocabularyPage(library: LibraryStorage, value: unknown = {}): VocabularyPage {
  const filter = vocabularyQuery(value), titles = new Map<string, string>();
  const all = library.db.listVocabulary({ limit: 50000 }).map(row => view(library, row, titles));
  const terms = filter.query?.toLocaleLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const items = all.filter(item => {
    const text = `${item.word} ${item.book_title} ${item.device_name} ${item.context.sentence}`.toLocaleLowerCase();
    return (!filter.deviceId || item.device_id === filter.deviceId) &&
      (!filter.bookId || item.book_key === filter.bookId) &&
      (!filter.pushState || item.push_state === filter.pushState) &&
      terms.every(term => text.includes(term));
  });
  const totals = { all: all.length, pending: 0, pushed: 0, conflict: 0, error: 0 };
  for (const item of all) totals[item.push_state]++;
  return {
    summary: vocabularySummary(library, titles, filter.month_start),
    items,
    devices: countChoices(all, item => item.device_id, item => item.device_name),
    books: countChoices(all, item => item.book_key, item => item.book_title),
    totals,
  };
}
