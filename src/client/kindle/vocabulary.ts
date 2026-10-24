import type { Database, SqlJsStatic } from "sql.js";
import type { VocabularyWord } from "../../server/vocabulary/input";
import { bookFingerprint } from "../../core/fingerprint";
import { cleanVocabularyWord } from "../../core/vocabulary";
import { loadKoboDatabase } from "../devices/kobo/reading";
import { entryOperation, optionalDirectory, optionalEntry, type DeviceDirectory, type DeviceFile, type KindleDirectory } from "./fs";
import type { DeviceManifest, ManifestBook } from "./manifest";

export type KindleBookResolver = (book: { book_id?: string | null; fingerprint?: string | null; filename: string }) => string | null;
export interface KindleVocabulary { words: VocabularyWord[]; skipped: number }
type RawRow = Record<string, unknown>;
const text = (value: unknown): string | null => typeof value === "string" && value ? value : null;
const key = (value: unknown): string | null => value === null || value === undefined ? null : String(value);
const basename = (filename: string) => filename.split("/").at(-1)!.replace(/\.[^.]+$/, "");

function rows(db: Database, table: string): RawRow[] {
  let statement;
  try { statement = db.prepare(`SELECT * FROM ${table}`); }
  catch { return []; }
  try {
    const out: RawRow[] = [];
    while (statement.step()) out.push(statement.getAsObject() as RawRow);
    return out;
  } finally { statement.free(); }
}
function time(value: unknown): string | null {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isFinite(number)) return null;
  const date = new Date(number);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function lookupId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const id = String(value);
  return id && id.length <= 128 && !id.includes("\0") ? id : null;
}

/** Missing files/tables are an empty vocabulary; each broken lookup row is counted and skipped. */
export async function parseKindleVocabulary(data: Uint8Array, manifest: DeviceManifest = { version: 1, books: [] }, resolver?: KindleBookResolver, load: () => Promise<SqlJsStatic> = loadKoboDatabase): Promise<KindleVocabulary> {
  const SQL = await load(), db = new SQL.Database(data), words: VocabularyWord[] = [];
  let skipped = 0;
  try {
    const lookups = rows(db, "LOOKUPS");
    if (!lookups.length) return { words, skipped };
    const wordRows = new Map(rows(db, "WORDS").map(row => [key(row.id), row] as const).filter(([id]) => id !== null));
    const books = new Map(rows(db, "BOOK_INFO").map(row => [key(row.id), row] as const).filter(([id]) => id !== null));
    const byContentId = new Map<string, ManifestBook>();
    for (const book of manifest.books) byContentId.set(book.content_id, book);
    for (const lookup of lookups) {
      try {
        const wordRow = wordRows.get(key(lookup.word_key) ?? ""), raw = text(wordRow?.word);
        if (!raw) { skipped++; continue; }
        const word = cleanVocabularyWord(raw), looked_up_at = time(lookup.timestamp ?? wordRow?.timestamp);
        if (!word || !looked_up_at) { skipped++; continue; }
        const info = books.get(key(lookup.book_key) ?? ""), title = text(info?.title)?.trim() || "";
        const matched = byContentId.get(text(info?.asin) ?? "") ?? byContentId.get(text(info?.guid) ?? "");
        let book_id: string | null = null;
        if (matched) book_id = resolver?.({ book_id: matched.book_id, fingerprint: matched.fingerprint ?? null, filename: matched.filename }) ?? matched.book_id;
        else if (title) {
          const fingerprint = await bookFingerprint(title, text(info?.authors));
          book_id = resolver?.({ fingerprint, filename: "" }) ?? null;
        }
        const usage = text(lookup.usage) ?? "";
        words.push({
          lookup_id: lookupId(lookup.id),
          raw_word: raw,
          word,
          lang: text(wordRow?.lang) ?? text(info?.lang),
          book_id,
          source_title: title || (matched ? basename(matched.filename) : "Kindle"),
          looked_up_at,
          context: { sentence: usage, previous: [], following: [] },
        });
      } catch { skipped++; }
    }
  } finally { db.close(); }
  return { words, skipped };
}

async function vocabularyFile(root: KindleDirectory): Promise<DeviceFile | null> {
  const system = await optionalDirectory(root, "system");
  if (!system) return null;
  const vocabulary = await optionalDirectory(system, "vocabulary", root, "system");
  if (!vocabulary) return null;
  const entry = await optionalEntry(root, vocabulary, "vocab.db", "system/vocabulary");
  return entry?.kind === "file" ? entry : null;
}

/** Read-only pass over `system/vocabulary/vocab.db`; the database is never written. */
export async function readKindleVocabulary(root: KindleDirectory, manifest: DeviceManifest, books: readonly { book_id: string; title: string; author: string | null }[] = [], load: () => Promise<SqlJsStatic> = loadKoboDatabase, resolve?: KindleBookResolver): Promise<KindleVocabulary> {
  void books;
  const file = await vocabularyFile(root);
  if (!file) return { words: [], skipped: 0 };
  const data = await entryOperation(root, "system/vocabulary/vocab.db", async () => new Uint8Array(await (await file.getFile()).arrayBuffer()));
  return parseKindleVocabulary(data, manifest, resolve, load);
}

export type { DeviceDirectory };
