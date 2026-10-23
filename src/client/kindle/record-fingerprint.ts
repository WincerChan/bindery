import { bookFingerprint } from "../../core/fingerprint";
import { entryOperation, type KindleDirectory } from "./fs";
import { readKfxBookMetadata } from "./kfx-metadata";
import type { ManifestBook } from "./manifest";

interface CachedFingerprint { size: number; modified: number; fingerprint: string | null }
let caches = new WeakMap<KindleDirectory, Map<string, CachedFingerprint>>();
export function clearKindleFingerprintCache(root?: KindleDirectory) {
  if (root) caches.delete(root);
  else caches = new WeakMap();
}
/** Cached by filename and file identity; a damaged or non-boko KFX simply has no fingerprint. */
export async function kindleFileFingerprint(root: KindleDirectory, filename: string, snapshot: File): Promise<string | null> {
  const cache = caches.get(root) ?? new Map<string, CachedFingerprint>(), key = filename.toLowerCase();
  caches.set(root, cache);
  const previous = cache.get(key);
  if (previous && previous.size === snapshot.size && previous.modified === snapshot.lastModified) return previous.fingerprint;
  let fingerprint: string | null = null;
  try { const metadata = await readKfxBookMetadata(snapshot); fingerprint = await bookFingerprint(metadata.title, metadata.author); }
  catch { /* An unsupported KFX has no fingerprint; matching falls back to its record id. */ }
  cache.set(key, { size: snapshot.size, modified: snapshot.lastModified, fingerprint });
  return fingerprint;
}
export async function kindleRecordFingerprint(root: KindleDirectory, record: ManifestBook): Promise<string | null> {
  if (record.fingerprint) return record.fingerprint;
  try {
    const parts = record.filename.split("/"), name = parts.pop()!, path = `documents/${record.filename}`;
    const snapshot = await entryOperation(root, path, async () => {
      let dir = await root.getDirectoryHandle("documents");
      for (const part of parts) dir = await dir.getDirectoryHandle(part);
      return (await dir.getFileHandle(name)).getFile();
    });
    return await kindleFileFingerprint(root, record.filename, snapshot);
  } catch { return null; }
}
