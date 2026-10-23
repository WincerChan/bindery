import { readManifest } from "../../client/kindle/manifest";
import { readKindleReading } from "../../client/kindle/reading";
import { createDeviceLibraryResolver, loadDeviceLibrary } from "./library";
import type { KindleReadingSync } from "./kindle-summary";

export { kindleReadingSummary, type KindleAutoSyncResult, type KindleReadingSync } from "./kindle-summary";
export const syncKindleDevice: KindleReadingSync = async device => {
  const [{ loadLibrary }, { syncKindleReading }, manifest] = await Promise.all([import("../library/functions"), import("../../server/reading/functions"), readManifest(device.root)]);
  const books = await loadDeviceLibrary(page => loadLibrary({ data: { page, per_page: 96 } }));
  const resolver = await createDeviceLibraryResolver(books, "kindle");
  const reading = await readKindleReading(device.root, manifest, resolver.match);
  if (!reading.entries.length) return { synced: 0, skipped: reading.skipped, missing: 0, marked_read: 0, unchanged: 0, kept: 0, unmatched: reading.unmatched };
  const result = await syncKindleReading({ data: { device: { id: device.identity.id, kind: "kindle", name: device.identity.name }, books: reading.entries } });
  return { ...result, skipped: reading.skipped, missing: result.skipped, unmatched: reading.unmatched };
};
