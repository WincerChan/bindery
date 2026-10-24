import { cleanVocabularyWord } from "../../core/vocabulary";

export interface VocabularyContext {
  sentence: string;
  previous: string[];
  following: string[];
}

export interface VocabularyWord {
  /** Kindle LOOKUPS.id; Kobo rows use the deterministic word + timestamp identity. */
  lookup_id: string | null;
  raw_word: string;
  word: string;
  lang: string | null;
  book_id: string | null;
  source_title: string;
  looked_up_at: string;
  context: VocabularyContext | null;
}

export interface VocabularyDevice { id: string; kind: "kobo" | "kindle"; name: string }
export interface VocabularyInput { device: VocabularyDevice; words: VocabularyWord[] }

function invalid(): never { throw new Error("生词同步数据无效"); }
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
function text(value: unknown, pattern: RegExp, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || !pattern.test(value)) return invalid();
  return value;
}
function nullableText(value: unknown, maximum: number): string | null {
  if (value === null || value === undefined) return null;
  return text(value, /^[^\0]*$/, maximum);
}
function context(value: unknown): VocabularyContext | null {
  if (value === null || value === undefined) return null;
  const row = record(value);
  if (!row) return invalid();
  const list = (items: unknown): string[] => {
    if (items === undefined || items === null) return [];
    if (!Array.isArray(items) || items.length > 64) return invalid();
    return items.map(item => text(item, /^[^\0]*$/, 8192));
  };
  return {
    sentence: text(row.sentence, /^[^\0]*$/, 32768),
    previous: list(row.previous),
    following: list(row.following),
  };
}
function word(value: unknown): VocabularyWord {
  const row = record(value);
  if (!row) return invalid();
  const raw_word = text(row.raw_word, /\S/, 2000);
  const cleaned = row.word === undefined ? cleanVocabularyWord(raw_word) : text(row.word, /\S/, 2000);
  if (!cleaned) return invalid();
  const book_id = row.book_id === null || row.book_id === undefined ? null : text(row.book_id, /^[a-f0-9]{32}$/, 32);
  const parsed = typeof row.looked_up_at === "string" ? Date.parse(row.looked_up_at) : NaN;
  if (!Number.isFinite(parsed)) return invalid();
  return {
    lookup_id: nullableText(row.lookup_id, 128),
    raw_word,
    word: cleaned,
    lang: nullableText(row.lang, 64),
    book_id,
    source_title: text(row.source_title, /^[^\0]*$/, 2048),
    looked_up_at: new Date(parsed).toISOString(),
    context: context(row.context),
  };
}
export function vocabularyInput(value: unknown): VocabularyInput {
  const input = record(value), device = record(input?.device);
  if (!input || !device || (device.kind !== "kobo" && device.kind !== "kindle")) return invalid();
  if (!Array.isArray(input.words) || input.words.length > 5000) return invalid();
  return {
    device: { id: text(device.id, /^[\w-]{1,128}$/, 128), kind: device.kind, name: text(device.name, /\S/, 100) },
    words: input.words.map(word),
  };
}
