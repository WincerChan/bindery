import { readKoboReading } from "../../client/devices/kobo/reading";
import { createDeviceLibraryResolver, loadDeviceLibrary } from "./library";
import type { KoboReadingSync } from "./kobo-summary";

export { koboReadingSummary, type KoboAutoSyncResult, type KoboReadingSync } from "./kobo-summary";
export const syncKoboDevice: KoboReadingSync = async device => {
  const [{ loadLibrary }, { syncKoboReading }] = await Promise.all([import("../library/functions"), import("../../server/reading/functions")]);
  const books = await loadDeviceLibrary(page => loadLibrary({ data: { page, per_page: 96 } }));
  const resolver = await createDeviceLibraryResolver(books, "kobo");
  const reading = await readKoboReading(device.root, books, undefined, resolver.match);
  if (!reading.entries.length) return { synced: 0, skipped: 0, marked_read: 0, unchanged: 0, kept: 0, lagged: reading.wal, unmatched: reading.unmatched };
  const result = await syncKoboReading({ data: { device: { id: device.identity.id, kind: "kobo", name: device.identity.name }, books: reading.entries } });
  return { ...result, lagged: reading.wal, unmatched: reading.unmatched };
};
