import { readKoboReading } from "../../client/devices/kobo/reading";
import { readKoboVocabulary } from "../../client/devices/kobo/vocabulary";
import { createDeviceLibraryResolver, loadDeviceLibrary } from "./library";
import type { KoboReadingSync } from "./kobo-summary";

export { koboReadingSummary, type KoboAutoSyncResult, type KoboReadingSync } from "./kobo-summary";
export const syncKoboDevice: KoboReadingSync = async device => {
  const [{ loadLibrary }, { syncKoboReading }, vocabularyApi] = await Promise.all([import("../library/functions"), import("../../server/reading/functions"), import("../../server/vocabulary/functions")]);
  const books = await loadDeviceLibrary(page => loadLibrary({ data: { page, per_page: 96 } }));
  const resolver = await createDeviceLibraryResolver(books, "kobo");
  const reading = await readKoboReading(device.root, books, undefined, resolver.match);
  const vocabulary = await readKoboVocabulary(device.root, books, undefined, resolver.match);
  const result = reading.entries.length
    ? await syncKoboReading({ data: { device: { id: device.identity.id, kind: "kobo", name: device.identity.name }, books: reading.entries } })
    : { synced: 0, skipped: 0, marked_read: 0, unchanged: 0, kept: 0 };
  const pushed = vocabulary.words.length
    ? await vocabularyApi.syncVocabulary({ data: { device: { id: device.identity.id, kind: "kobo", name: device.identity.name }, words: vocabulary.words } })
    : { synced: 0, unchanged: 0, skipped: 0, context_found: 0, context_not_found: 0, context_pending: 0 };
  return { ...result, lagged: reading.wal, unmatched: reading.unmatched, vocabulary: pushed.synced + pushed.unchanged, vocabulary_skipped: vocabulary.skipped + pushed.skipped };
};
