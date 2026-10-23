export interface KoboEntry {
  book_id: string;
  location: string | null;
  chapter_fraction: number | null;
  percent: number;
  read_status: 0 | 1 | 2;
  last_read_at: string | null;
  time_spent_seconds: number;
  rest_estimate_seconds: number | null;
}
export interface KoboDevice { id: string; kind: "kobo"; name: string }
export interface KoboReadingInput { device: KoboDevice; books: KoboEntry[] }
export interface KindleEntry {
  book_id: string;
  location: string;
  chapter: number | null;
  kfx_section_count: number;
  chapter_fraction: number | null;
  percent: number;
  last_read_at: string;
}
export interface KindleDevice { id: string; kind: "kindle"; name: string }
export interface KindleReadingInput { device: KindleDevice; books: KindleEntry[] }
function invalid(): never { throw new Error("同步数据无效"); }
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nullableFinite = (value: unknown): value is number | null => value === null || finite(value);
function text(value: unknown, pattern: RegExp, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || !pattern.test(value)) return invalid();
  return value;
}
function device(value: unknown, kind: "kobo" | "kindle"): { id: string; kind: "kobo" | "kindle"; name: string } {
  const row = record(value);
  if (!row || row.kind !== kind) return invalid();
  return { id: text(row.id, /^[\w-]{1,128}$/, 128), kind, name: text(row.name, /\S/, 100) };
}
function entries(value: unknown, parse: (entry: unknown) => KoboEntry | KindleEntry): Array<KoboEntry | KindleEntry> {
  if (!Array.isArray(value) || value.length > 5000) return invalid();
  return value.map(parse);
}
function koboEntry(value: unknown): KoboEntry {
  const row = record(value);
  if (!row) return invalid();
  const book_id = text(row.book_id, /^[a-f0-9]{32}$/, 32);
  const location = row.location === null ? null : text(row.location, /^[^\0]*$/, 4096);
  if (!nullableFinite(row.chapter_fraction) || !finite(row.percent) || !Number.isInteger(row.read_status) || !nullableFinite(row.rest_estimate_seconds)) return invalid();
  if (![0, 1, 2].includes(row.read_status as number) || !finite(row.time_spent_seconds) || row.time_spent_seconds < 0) return invalid();
  if (row.last_read_at !== null && (typeof row.last_read_at !== "string" || !Number.isFinite(Date.parse(row.last_read_at)))) return invalid();
  return {
    book_id,
    location,
    chapter_fraction: row.chapter_fraction as number | null,
    percent: row.percent as number,
    read_status: row.read_status as 0 | 1 | 2,
    last_read_at: row.last_read_at as string | null,
    time_spent_seconds: row.time_spent_seconds as number,
    rest_estimate_seconds: row.rest_estimate_seconds as number | null,
  };
}
function kindleEntry(value: unknown): KindleEntry {
  const row = record(value);
  if (!row) return invalid();
  const book_id = text(row.book_id, /^[a-f0-9]{32}$/, 32);
  const location = text(row.location, /^[^\0]+$/, 4096);
  if (!Number.isInteger(row.kfx_section_count) || (row.kfx_section_count as number) < 0) return invalid();
  if (row.chapter !== null && (!Number.isInteger(row.chapter) || (row.chapter as number) < 0 || (row.chapter as number) >= (row.kfx_section_count as number))) return invalid();
  if (!nullableFinite(row.chapter_fraction) || !finite(row.percent)) return invalid();
  if (typeof row.last_read_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(row.last_read_at) || !Number.isFinite(Date.parse(row.last_read_at))) return invalid();
  return {
    book_id,
    location,
    chapter: row.chapter as number | null,
    kfx_section_count: row.kfx_section_count as number,
    chapter_fraction: row.chapter_fraction as number | null,
    percent: row.percent as number,
    last_read_at: row.last_read_at,
  };
}
export function koboReadingInput(value: unknown): KoboReadingInput {
  const input = record(value);
  if (!input) return invalid();
  const current = device(input.device, "kobo") as KoboDevice;
  return { device: current, books: entries(input.books, koboEntry) as KoboEntry[] };
}
export function kindleReadingInput(value: unknown): KindleReadingInput {
  const input = record(value);
  if (!input) return invalid();
  const current = device(input.device, "kindle") as KindleDevice;
  return { device: current, books: entries(input.books, kindleEntry) as KindleEntry[] };
}
