import { nowIso, type DeviceReading } from "../db";
import { HttpError } from "../http";
import { setReadStatus } from "../books/service";
import type { LibraryStorage } from "../storage";
import { mapKoboPosition } from "./kobo";
import { koboReadingInput as parseKoboReadingInput, type KoboReadingInput } from "./input";

export type { KoboDevice, KoboEntry, KoboReadingInput } from "./input";
export interface KoboReadingResult { synced: number; skipped: number; marked_read: number; unchanged: number }
const READ_STATUS = ["unread", "reading", "finished"] as const;
export function koboReadingInput(value: unknown): KoboReadingInput {
  try { return parseKoboReadingInput(value); }
  catch { throw new HttpError(422, "同步数据无效"); }
}
const COMPARED: readonly (keyof DeviceReading)[] = ["book_id", "device_id", "device_kind", "device_name", "section", "section_fraction", "percent", "location", "read_status", "last_read_at", "time_spent_seconds", "rest_estimate_seconds"];
const sameReading = (previous: DeviceReading | undefined, row: DeviceReading) => Boolean(previous) && COMPARED.every(column => previous![column] === row[column]);

export function syncKoboReading(library: LibraryStorage, value: unknown): KoboReadingResult {
  const { device, books } = koboReadingInput(value), synced_at = nowIso();
  const result: KoboReadingResult = { synced: 0, skipped: 0, marked_read: 0, unchanged: 0 };
  for (const entry of books) {
    if (!library.ensureBookExists(entry.book_id)) { result.skipped++; continue; }
    let position;
    try { position = mapKoboPosition(library, entry.book_id, entry); }
    catch (error) {
      if (error instanceof HttpError && error.status === 404) { result.skipped++; continue; }
      throw error;
    }
    const row: DeviceReading = {
      book_id: entry.book_id, device_id: device.id, device_kind: device.kind, device_name: device.name,
      section: position.section, section_fraction: position.section_fraction, percent: position.percent,
      location: entry.location, read_status: READ_STATUS[entry.read_status], last_read_at: entry.last_read_at,
      time_spent_seconds: Math.max(0, Math.trunc(entry.time_spent_seconds)),
      rest_estimate_seconds: entry.rest_estimate_seconds === null ? null : Math.max(0, Math.trunc(entry.rest_estimate_seconds)),
      synced_at,
    };
    const previous = library.db.listDeviceReading(entry.book_id).find(item => item.device_id === device.id);
    if (sameReading(previous, row)) result.unchanged++;
    else {
      library.db.upsertDeviceReading(row);
      result.synced++;
    }
    if (entry.read_status === 2 && !library.loadMetadata(entry.book_id).read) {
      setReadStatus(entry.book_id, "1", library);
      result.marked_read++;
    }
  }
  return result;
}
