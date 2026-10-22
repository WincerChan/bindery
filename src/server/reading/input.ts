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
function invalid(): never { throw new Error("同步数据无效"); }
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nullableFinite = (value: unknown): value is number | null => value === null || finite(value);
function text(value: unknown, pattern: RegExp, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || !pattern.test(value)) return invalid();
  return value;
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
export function koboReadingInput(value: unknown): KoboReadingInput {
  const input = record(value);
  if (!input) return invalid();
  const device = record(input.device);
  if (!device || device.kind !== "kobo") return invalid();
  const id = text(device.id, /^[\w-]{1,128}$/, 128);
  const name = text(device.name, /\S/, 100);
  if (!Array.isArray(input.books) || input.books.length > 5000) return invalid();
  return { device: { id, kind: "kobo", name }, books: input.books.map(koboEntry) };
}
