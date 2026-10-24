import { readManifest } from "../../client/kindle/manifest";
import { readKindleReading } from "../../client/kindle/reading";
import { readKindleVocabulary } from "../../client/kindle/vocabulary";
import { createDeviceLibraryResolver, loadDeviceLibrary } from "./library";
import type { KindleReadingSync } from "./kindle-summary";

export { kindleReadingSummary, type KindleAutoSyncResult, type KindleReadingSync } from "./kindle-summary";
export const syncKindleDevice: KindleReadingSync = async device => {
  const [{ loadLibrary }, { syncKindleReading }, vocabularyApi, manifest] = await Promise.all([import("../library/functions"), import("../../server/reading/functions"), import("../../server/vocabulary/functions"), readManifest(device.root)]);
  const books = await loadDeviceLibrary(page => loadLibrary({ data: { page, per_page: 96 } }));
  const resolver = await createDeviceLibraryResolver(books, "kindle");
  const reading = await readKindleReading(device.root, manifest, resolver.match);
  const vocabulary = await readKindleVocabulary(device.root, manifest, books, undefined, resolver.match);
  const result = reading.entries.length
    ? await syncKindleReading({ data: { device: { id: device.identity.id, kind: "kindle", name: device.identity.name }, books: reading.entries } })
    : { synced: 0, skipped: 0, marked_read: 0, unchanged: 0, kept: 0 };
  const pushed = vocabulary.words.length
    ? await vocabularyApi.syncVocabulary({ data: { device: { id: device.identity.id, kind: "kindle", name: device.identity.name }, words: vocabulary.words } })
    : { synced: 0, unchanged: 0, skipped: 0, context_found: 0, context_not_found: 0, context_pending: 0 };
  return { ...result, skipped: reading.skipped, missing: result.skipped, unmatched: reading.unmatched, vocabulary: pushed.synced + pushed.unchanged, vocabulary_skipped: vocabulary.skipped + pushed.skipped };
};
