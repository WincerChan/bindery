import { statSync } from "node:fs";
import { CountArchive } from "./count-archive";
import { countEpubWords } from "./word-count-estimate";
import { epubPath, type LibraryStorage } from "../storage";

/** word_count is approximate for large books, exact for small or uneven books. */
export interface BookFileStats { word_count: number | null; file_size: number | null }
interface CachedCount { word_count: number | null; word_count_key: string | null }
const readCache = (id: string, library: LibraryStorage) => library.db.get<CachedCount>("SELECT word_count, word_count_key FROM books WHERE book_id = ?", id);
const fileKey = (stat: { size: number; mtimeMs: number }) => `v2:${stat.size}:${stat.mtimeMs}`;
/** Last-known statistics for mutation replies; no stat, EPUB reads, extraction or writes.
 * The next detail load validates the identity. Keep the previous count while edits are queued.
 */
export function cachedBookFileStats(id: string, library: LibraryStorage): BookFileStats {
  const cached = readCache(id, library);
  return { word_count: cached?.word_count ?? null, file_size: cached?.word_count_key ? Number(cached.word_count_key.split(":").at(-2)) : null };
}
export function bookFileStats(id: string, library: LibraryStorage): BookFileStats {
  const path = epubPath(library.base, id);
  let stat: ReturnType<typeof statSync>;
  try { stat = statSync(path); if (!stat.isFile()) return { word_count: null, file_size: null }; }
  catch { return { word_count: null, file_size: null }; }
  const key = fileKey(stat), cached = readCache(id, library);
  if (cached?.word_count_key === key) return { word_count: cached.word_count, file_size: stat.size };
  let count: number | null = null;
  try {
    count = countEpubWords(new CountArchive(path, statSync(path, { bigint: true }), () => {})).count;
  } catch { /* Missing, unreadable or corrupt EPUBs must not break book details. */ }
  // A concurrent write must not publish a count under the identity of different bytes.
  try { if (fileKey(statSync(path)) !== key) return { word_count: null, file_size: stat.size }; }
  catch { return { word_count: null, file_size: null }; }
  // Deliberately bypass saveMetadata: no timestamps, tracker, CSS or file writes.
  // Cache failures too; replacing the EPUB retries automatically via its identity.
  library.db.run("UPDATE books SET word_count = ?, word_count_key = ? WHERE book_id = ?", count, key, id);
  return { word_count: count, file_size: stat.size };
}
