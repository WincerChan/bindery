import { entryName, readInternalJson, type KindleDirectory } from "../fs";

export interface KoboManifestBook { book_id: string; filename: string; transferred_at: string }
export interface KoboManifest { version: 1; books: KoboManifestBook[] }
const manifestError = () => new Error("Kobo 传输记录损坏，请检查 .bindery/manifest.json");
const validFilename = (filename: unknown): filename is string => {
  if (typeof filename !== "string" || !/^Bindery\/.+\.kepub\.epub$/i.test(filename)) return false;
  try { filename.split("/").forEach(part => entryName(part)); return true; }
  catch { return false; }
};
export function parseKoboManifest(value: unknown): KoboManifest {
  const v = value as Partial<KoboManifest> | null;
  if (!v || v.version !== 1 || !Array.isArray(v.books)) throw manifestError();
  const filenames = new Set<string>(), bookIds = new Set<string>();
  for (const book of v.books) {
    if (!book || typeof book.book_id !== "string" || !/^[a-f0-9]{32}$/.test(book.book_id) || !validFilename(book.filename) || typeof book.transferred_at !== "string" || !Number.isFinite(Date.parse(book.transferred_at)) || filenames.has(book.filename.toLowerCase()) || bookIds.has(book.book_id)) throw manifestError();
    filenames.add(book.filename.toLowerCase()); bookIds.add(book.book_id);
  }
  return structuredClone(v as KoboManifest);
}
export async function readKoboManifest(root: KindleDirectory): Promise<KoboManifest> {
  const value = await readInternalJson(root, "manifest.json", "kobo");
  return value === undefined ? { version: 1, books: [] } : parseKoboManifest(value);
}
export const koboManifestBytes = (manifest: KoboManifest) => JSON.stringify(parseKoboManifest(manifest), null, 2);
/** One record per book and per file; a re-transfer replaces the old filename. */
export function withKoboManifestBook(manifest: KoboManifest, record: KoboManifestBook): KoboManifest {
  const books = manifest.books.filter(book => book.book_id !== record.book_id && book.filename.toLowerCase() !== record.filename.toLowerCase());
  return parseKoboManifest({ version: 1, books: [...books, record] });
}
export function withoutKoboManifestBook(manifest: KoboManifest, filename: string): KoboManifest {
  return parseKoboManifest({ version: 1, books: manifest.books.filter(book => book.filename.toLowerCase() !== filename.toLowerCase()) });
}
