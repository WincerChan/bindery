import type { LibraryStorage } from "../storage";

export type ProgressSource = "web" | { device_id: string; device_name: string; kind: string };
export interface LatestProgress {
  source: ProgressSource;
  section: number | null;
  section_fraction: number | null;
  page?: number;
  page_count?: number;
  percent?: number | null;
  read_at: string;
}
/** Newest last-read time wins; a device row without a read time has never been opened. */
export function latestProgress(library: LibraryStorage, bookId: string): LatestProgress | null {
  let latest: LatestProgress | null = null, newest = -Infinity;
  const web = library.db.getReaderProgress(bookId);
  const webTime = web ? Date.parse(web.updated_at) : NaN;
  if (web && Number.isFinite(webTime)) {
    latest = { source: "web", section: web.section, section_fraction: (web.page - 1) / Math.max(1, web.page_count - 1), page: web.page, page_count: web.page_count, read_at: web.updated_at };
    newest = webTime;
  }
  for (const row of library.db.listDeviceReading(bookId)) {
    const time = row.last_read_at ? Date.parse(row.last_read_at) : NaN;
    if (!Number.isFinite(time) || time <= newest) continue;
    latest = { source: { device_id: row.device_id, device_name: row.device_name, kind: row.device_kind }, section: row.section, section_fraction: row.section_fraction, percent: row.percent, read_at: row.last_read_at! };
    newest = time;
  }
  return latest;
}
