import type { LibraryStorage } from "../../server/storage";
import { bookView } from "../../server/book-view";

/** Shelf-wide facts are independent of the current search, filter and page. */
export function librarySummary(library: LibraryStorage) {
  const [recent, active_count] = library.listBooksPage({ sort: "created", per_page: 1 });
  const [, archived_count] = library.listBooksPage({ scope: "archived", per_page: 1 });
  const progress = library.db.all<{ book_id: string; section: number | null; read_at: string }>(`
    SELECT p.* FROM (
      SELECT book_id, section, updated_at AS read_at FROM reader_progress
      UNION ALL
      SELECT book_id, section, last_read_at AS read_at FROM device_reading
    ) p JOIN books b ON b.book_id = p.book_id
    WHERE b.archived = 0 AND julianday(p.read_at) IS NOT NULL
    ORDER BY julianday(p.read_at) DESC`);
  const latest = progress.find(row => library.ensureBookExists(row.book_id));
  const meta = latest ? library.loadMetadata(latest.book_id) : recent[0];
  return {
    active_count, archived_count,
    hero: meta ? bookView(meta, library) : null,
    latest: latest ? { section: latest.section, read_at: latest.read_at } : null,
    generating_ids: [...new Set(library.db.listJobs("running").flatMap(job => job.book_id ? [job.book_id] : []))],
  };
}
export type LibrarySummary = ReturnType<typeof librarySummary>;
