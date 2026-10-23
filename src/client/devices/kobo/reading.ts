import wasmUrl from "sql.js/dist/sql-wasm-browser.wasm?url";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import type { KoboEntry } from "../../../server/reading/input";
import { directoryEntries, entryOperation, type KindleDirectory } from "../fs";
import { koboBookFilename } from "../paths";
import { readKoboManifest, type KoboManifest } from "./manifest";

export type KoboDatabaseLoader = () => Promise<SqlJsStatic>;
export interface KoboContentRow {
  filename: string;
  location: string | null;
  chapter_fraction: number | null;
  percent: number;
  read_status: 0 | 1 | 2;
  last_read_at: string | null;
  time_spent_seconds: number;
  rest_estimate_seconds: number | null;
}
export interface KoboReading {
  manifest: KoboManifest;
  rows: KoboContentRow[];
  entries: KoboEntry[];
  bookIds: Map<string, string>;
  wal: boolean;
  unmatched: number;
}
export interface KoboFallbackBook { book_id: string; title: string }
export type KoboBookResolver = (book: { book_id?: string | null; fingerprint?: string | null; filename: string }) => string | null;
const contentPrefix = "file:///mnt/onboard/";
const sqlitePath = ".kobo/KoboReader.sqlite";
const contentQuery = `SELECT ContentID, ReadStatus, ___PercentRead, ChapterIDBookmarked, CurrentChapterProgress, DateLastRead, TimeSpentReading, RestOfBookEstimate FROM content WHERE ContentType = 6 AND ContentID LIKE 'file:///mnt/onboard/Bindery/%'`;
let database: Promise<SqlJsStatic> | undefined;
const numberOrNull = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const textOrNull = (value: unknown): string | null => typeof value === "string" ? value : null;
export const loadKoboDatabase = (): Promise<SqlJsStatic> => database ??= (async () => {
  const node = typeof window === "undefined" ? (globalThis as { process?: { cwd(): string } }).process : undefined;
  return initSqlJs({ locateFile: () => node && wasmUrl.startsWith("/") ? `${node.cwd()}${wasmUrl}` : wasmUrl });
})().catch(error => { database = undefined; throw error; });

/** `file:///mnt/onboard/Bindery/x.kepub.epub` → `Bindery/x.kepub.epub`; never touched except by reads. */
export function koboContentFilename(contentId: unknown): string | null {
  if (typeof contentId !== "string" || !contentId.startsWith(contentPrefix)) return null;
  const filename = contentId.slice(contentPrefix.length);
  try { return decodeURIComponent(filename); }
  catch { return filename; }
}
export async function parseKoboContent(data: Uint8Array, load: KoboDatabaseLoader = loadKoboDatabase): Promise<KoboContentRow[]> {
  const SQL = await load(), db = new SQL.Database(data);
  try {
    const statement = db.prepare(contentQuery), rows: KoboContentRow[] = [];
    try {
      while (statement.step()) {
        const row = statement.getAsObject(), filename = koboContentFilename(row.ContentID);
        if (!filename) continue;
        const status = row.ReadStatus, read_status: 0 | 1 | 2 = status === 1 || status === 2 ? status : 0;
        rows.push({
          filename,
          location: textOrNull(row.ChapterIDBookmarked),
          chapter_fraction: numberOrNull(row.CurrentChapterProgress),
          percent: numberOrNull(row.___PercentRead) ?? 0,
          read_status,
          last_read_at: textOrNull(row.DateLastRead),
          time_spent_seconds: numberOrNull(row.TimeSpentReading) ?? 0,
          rest_estimate_seconds: numberOrNull(row.RestOfBookEstimate),
        });
      }
    } finally { statement.free(); }
    return rows;
  } finally { db.close(); }
}
/** Manifest first; old transfers fall back only when one library title maps to the filename. */
export function koboReadingBookIds(manifest: KoboManifest, books: readonly KoboFallbackBook[] = [], resolve?: KoboBookResolver): Map<string, string> {
  const ids = new Map<string, string>();
  if (resolve) {
    for (const book of manifest.books) {
      const id = resolve(book);
      if (id) ids.set(book.filename.toLowerCase(), id);
    }
  } else for (const book of manifest.books) ids.set(book.filename.toLowerCase(), book.book_id);
  const fallback = new Map<string, string | null>();
  for (const book of books) {
    const filename = `Bindery/${koboBookFilename(book.title)}`.toLowerCase();
    const id = resolve ? resolve({ filename }) : book.book_id;
    const current = fallback.get(filename);
    if (current === undefined) fallback.set(filename, id);
    else if (current !== id) fallback.set(filename, null);
  }
  for (const [filename, book_id] of fallback) if (book_id && !ids.has(filename)) ids.set(filename, book_id);
  return ids;
}
export function koboReadingEntries(rows: readonly KoboContentRow[], manifest: KoboManifest, books: readonly KoboFallbackBook[] = [], resolve?: KoboBookResolver) {
  const bookIds = koboReadingBookIds(manifest, books, resolve), entries: KoboEntry[] = [];
  for (const row of rows) {
    const book_id = bookIds.get(row.filename.toLowerCase());
    if (!book_id) continue;
    entries.push({ book_id, location: row.location, chapter_fraction: row.chapter_fraction, percent: row.percent, read_status: row.read_status, last_read_at: row.last_read_at, time_spent_seconds: row.time_spent_seconds, rest_estimate_seconds: row.rest_estimate_seconds });
  }
  return { entries, bookIds, unmatched: rows.length - entries.length };
}
export async function readKoboReading(root: KindleDirectory, books: readonly KoboFallbackBook[] = [], load: KoboDatabaseLoader = loadKoboDatabase, resolve?: KoboBookResolver): Promise<KoboReading> {
  const manifest = await readKoboManifest(root), kobo = await entryOperation(root, ".kobo", () => root.getDirectoryHandle(".kobo"), "kobo");
  const entries = await directoryEntries(root, kobo, ".kobo", "kobo");
  const find = (name: string) => entries.find(entry => entry.kind === "file" && entry.name.toLowerCase() === name.toLowerCase());
  const database = find("KoboReader.sqlite"), walFile = find("KoboReader.sqlite-wal");
  const wal = walFile?.kind === "file" && (await walFile.getFile()).size > 0;
  const rows = database?.kind === "file" ? await parseKoboContent(new Uint8Array(await entryOperation(root, sqlitePath, async () => new Uint8Array(await (await database.getFile()).arrayBuffer()), "kobo")), load) : [];
  return { manifest, rows, wal, ...koboReadingEntries(rows, manifest, books, resolve) };
}
