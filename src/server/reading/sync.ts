import { nowIso, type DeviceReading } from "../db";
import { HttpError } from "../http";
import { setReadStatus } from "../books/service";
import type { LibraryStorage } from "../storage";
import { mapKoboPosition } from "./kobo";
import { mapKindlePosition } from "./kindle";
import {
  koboReadingInput as parseKoboReadingInput,
  kindleReadingInput as parseKindleReadingInput,
  type KoboReadingInput,
  type KindleReadingInput,
} from "./input";

export type { KoboDevice, KoboEntry, KoboReadingInput, KindleDevice, KindleEntry, KindleReadingInput } from "./input";
/** `kept`: the device reported an older or reset position, so the stored one stayed. */
export interface KoboReadingResult { synced: number; skipped: number; marked_read: number; unchanged: number; kept: number }
export type KindleReadingResult = KoboReadingResult;
const READ_STATUS = ["unread", "reading", "finished"] as const;
export function koboReadingInput(value: unknown): KoboReadingInput {
  try { return parseKoboReadingInput(value); }
  catch { throw new HttpError(422, "同步数据无效"); }
}
export function kindleReadingInput(value: unknown): KindleReadingInput {
  try { return parseKindleReadingInput(value); }
  catch { throw new HttpError(422, "同步数据无效"); }
}
const COMPARED: readonly (keyof DeviceReading)[] = ["book_id", "device_id", "device_kind", "device_name", "section", "section_fraction", "percent", "location", "read_status", "last_read_at", "time_spent_seconds", "rest_estimate_seconds"];
const sameReading = (previous: DeviceReading | undefined, row: DeviceReading) => Boolean(previous) && COMPARED.every(column => previous![column] === row[column]);
const readTime = (value: string | null | undefined) => value ? Date.parse(value) : NaN;
// A re-transfer or reset can make the device forget a book's position; that must not erase what it reported before.
const olderThanStored = (previous: DeviceReading | undefined, row: DeviceReading) =>
  Number.isFinite(readTime(previous?.last_read_at)) && !(readTime(row.last_read_at) >= readTime(previous!.last_read_at));

function upsertReading(library: LibraryStorage, device: { id: string }, row: DeviceReading, result: KoboReadingResult) {
  const previous = library.db.listDeviceReading(row.book_id).find(item => item.device_id === device.id);
  if (sameReading(previous, row)) result.unchanged++;
  else if (olderThanStored(previous, row)) result.kept++;
  else {
    library.db.upsertDeviceReading(row);
    result.synced++;
  }
}

export function syncKoboReading(library: LibraryStorage, value: unknown): KoboReadingResult {
  const { device, books } = koboReadingInput(value), synced_at = nowIso();
  const result: KoboReadingResult = { synced: 0, skipped: 0, marked_read: 0, unchanged: 0, kept: 0 };
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
    upsertReading(library, device, row, result);
    if (entry.read_status === 2 && !library.loadMetadata(entry.book_id).read) {
      setReadStatus(entry.book_id, "1", library);
      result.marked_read++;
    }
  }
  return result;
}

/** Kindle has no finished flag over USB, so it never marks a book read and stores no reading time. */
export function syncKindleReading(library: LibraryStorage, value: unknown): KindleReadingResult {
  const { device, books } = kindleReadingInput(value), synced_at = nowIso();
  const result: KindleReadingResult = { synced: 0, skipped: 0, marked_read: 0, unchanged: 0, kept: 0 };
  for (const entry of books) {
    if (!library.ensureBookExists(entry.book_id)) { result.skipped++; continue; }
    let position;
    try { position = mapKindlePosition(library, entry.book_id, entry); }
    catch (error) {
      if (error instanceof HttpError && error.status === 404) { result.skipped++; continue; }
      throw error;
    }
    upsertReading(library, device, {
      book_id: entry.book_id, device_id: device.id, device_kind: device.kind, device_name: device.name,
      section: position.section, section_fraction: position.section_fraction, percent: position.percent,
      location: entry.location, read_status: "reading", last_read_at: entry.last_read_at,
      time_spent_seconds: 0, rest_estimate_seconds: null, synced_at,
    }, result);
  }
  return result;
}
