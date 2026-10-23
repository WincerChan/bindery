import { readManifest } from "../../client/kindle/manifest";
import { readKindleReading } from "../../client/kindle/reading";
import type { KindleReadingSync } from "./kindle-summary";

export { kindleReadingSummary, type KindleAutoSyncResult, type KindleReadingSync } from "./kindle-summary";
export const syncKindleDevice: KindleReadingSync = async device => {
  const [{ syncKindleReading }, manifest] = await Promise.all([import("../../server/reading/functions"), readManifest(device.root)]);
  const reading = await readKindleReading(device.root, manifest);
  if (!reading.entries.length) return { synced: 0, skipped: reading.skipped, marked_read: 0, unchanged: 0, kept: 0, unmatched: reading.unmatched };
  const result = await syncKindleReading({ data: { device: { id: device.identity.id, kind: "kindle", name: device.identity.name }, books: reading.entries } });
  return { ...result, skipped: result.skipped + reading.skipped, unmatched: reading.unmatched };
};
