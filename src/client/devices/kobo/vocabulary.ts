import type { VocabularyWord } from "../../../server/vocabulary/input";
import { cleanVocabularyWord } from "../../../core/vocabulary";
import { directoryEntries, entryOperation, type KindleDirectory } from "../fs";
import { koboBookFilename } from "../paths";
import { readKoboManifest, type KoboManifest } from "./manifest";
import { koboContentFilename, koboReadingBookIds, loadKoboDatabase, type KoboBookResolver, type KoboDatabaseLoader, type KoboFallbackBook } from "./reading";

export interface KoboVocabularyRow {
  raw_word: string;
  word: string;
  lang: string | null;
  filename: string | null;
  looked_up_at: string;
}
export interface KoboVocabulary { words: VocabularyWord[]; skipped: number }
const sqlitePath = ".kobo/KoboReader.sqlite";

const text = (value: unknown): string | null => typeof value === "string" ? value : null;
function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Missing WordList tables produce no words; malformed rows are counted and skipped. */
export async function parseKoboVocabulary(data: Uint8Array, load: KoboDatabaseLoader = loadKoboDatabase): Promise<{ rows: KoboVocabularyRow[]; skipped: number }> {
  const SQL = await load(), db = new SQL.Database(data);
  const rows: KoboVocabularyRow[] = [];
  let skipped = 0;
  try {
    let statement;
    try { statement = db.prepare("SELECT Text, VolumeId, DictSuffix, DateCreated FROM WordList"); }
    catch { return { rows, skipped }; }
    try {
      while (statement.step()) {
        try {
          const row = statement.getAsObject();
          const raw = text(row.Text), looked_up_at = timestamp(row.DateCreated);
          if (raw === null || looked_up_at === null) { skipped++; continue; }
          const word = cleanVocabularyWord(raw);
          if (!word) { skipped++; continue; }
          rows.push({
            raw_word: raw,
            word,
            lang: text(row.DictSuffix),
            filename: koboContentFilename(row.VolumeId),
            looked_up_at,
          });
        } catch { skipped++; }
      }
    } finally { statement.free(); }
  } finally { db.close(); }
  return { rows, skipped };
}

export function koboVocabularyWords(rows: readonly KoboVocabularyRow[], manifest: KoboManifest, books: readonly KoboFallbackBook[] = [], resolve?: KoboBookResolver): VocabularyWord[] {
  const bookIds = koboReadingBookIds(manifest, books, resolve), titles = new Map(books.map(book => [book.book_id, book.title]));
  return rows.map(row => {
    const book_id = row.filename ? bookIds.get(row.filename.toLowerCase()) ?? null : null;
    const filenameTitle = row.filename ? row.filename.split("/").at(-1)!.replace(/\.kepub\.epub$/i, "") : "";
    return {
      lookup_id: null,
      raw_word: row.raw_word,
      word: row.word,
      lang: row.lang,
      book_id,
      source_title: (book_id ? titles.get(book_id) : undefined) || filenameTitle || "Kobo",
      looked_up_at: row.looked_up_at,
      context: null,
    };
  });
}

/** Read-only pass over `.kobo/KoboReader.sqlite`; the database is never written. */
export async function readKoboVocabulary(root: KindleDirectory, books: readonly KoboFallbackBook[] = [], load: KoboDatabaseLoader = loadKoboDatabase, resolve?: KoboBookResolver): Promise<KoboVocabulary> {
  const manifest = await readKoboManifest(root), kobo = await entryOperation(root, ".kobo", () => root.getDirectoryHandle(".kobo"), "kobo");
  const entries = await directoryEntries(root, kobo, ".kobo", "kobo");
  const database = entries.find(entry => entry.kind === "file" && entry.name.toLowerCase() === "koboreader.sqlite");
  if (!database || database.kind !== "file") return { words: [], skipped: 0 };
  const parsed = await parseKoboVocabulary(new Uint8Array(await entryOperation(root, sqlitePath, async () => new Uint8Array(await (await database.getFile()).arrayBuffer()), "kobo")), load);
  return { words: koboVocabularyWords(parsed.rows, manifest, books, resolve), skipped: parsed.skipped };
}

export { koboBookFilename };
