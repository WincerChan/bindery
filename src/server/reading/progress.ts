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

export interface ReadingProgressSource {
  source: ProgressSource;
  section: number | null;
  section_fraction: number | null;
  percent: number | null;
  read_at: string;
  time_spent_seconds: number | null;
  rest_estimate_seconds: number | null;
}
export interface ReadingProgressView extends ReadingProgressSource {
  source_label: string;
  section_title: string;
  latest: boolean;
}
/** Newest first; a device row without a read time has never been opened. */
export function listProgress(library: LibraryStorage, bookId: string): ReadingProgressSource[] {
  const entries: ReadingProgressSource[] = [], web = library.db.getReaderProgress(bookId), webTime = web ? Date.parse(web.updated_at) : NaN;
  if (web && Number.isFinite(webTime)) entries.push({ source: "web", section: web.section, section_fraction: (web.page - 1) / Math.max(1, web.page_count - 1), percent: null, read_at: web.updated_at, time_spent_seconds: null, rest_estimate_seconds: null });
  for (const row of library.db.listDeviceReading(bookId)) {
    const time = row.last_read_at ? Date.parse(row.last_read_at) : NaN;
    if (!Number.isFinite(time)) continue;
    entries.push({ source: { device_id: row.device_id, device_name: row.device_name, kind: row.device_kind }, section: row.section, section_fraction: row.section_fraction, percent: row.percent, read_at: row.last_read_at!, time_spent_seconds: row.time_spent_seconds, rest_estimate_seconds: row.rest_estimate_seconds });
  }
  return entries.sort((a, b) => Date.parse(b.read_at) - Date.parse(a.read_at));
}
export function readingProgressView(entries: readonly ReadingProgressSource[], sections: readonly { title: string }[]): ReadingProgressView[] {
  const total = sections.length, percentOf = (section: number | null, fraction: number | null) => section === null || !total ? null : Math.round((Math.max(0, Math.min(total - 1, section)) + Math.max(0, Math.min(1, fraction ?? 0))) / total * 100);
  return entries.map((entry, index) => ({
    ...entry,
    source_label: entry.source === "web" ? "网页阅读器" : entry.source.device_name || "Kobo 设备",
    section_title: entry.section === null ? "位置未知" : sections[entry.section]?.title || "未知章节",
    percent: entry.percent === null ? percentOf(entry.section, entry.section_fraction) : Math.round(entry.percent),
    latest: index === 0,
  }));
}
