import { readBookArchive } from "../reader/service";
import type { LibraryStorage } from "../storage";

/** The chapter each book was last read at on one device, for books whose position mapped to a section. */
export function deviceChapters(library: LibraryStorage, deviceId: string): Record<string, string> {
  const chapters: Record<string, string> = {};
  for (const row of library.db.listDeviceReadingForDevice(deviceId)) {
    if (row.section === null || !library.ensureBookExists(row.book_id)) continue;
    try {
      const title = readBookArchive(row.book_id, library).metadata().sections[row.section]?.title;
      if (title) chapters[row.book_id] = title;
    } catch { /* A book whose archive cannot be read just has no chapter label. */ }
  }
  return chapters;
}
