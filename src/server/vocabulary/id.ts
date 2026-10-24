import { createHash } from "node:crypto";

// Fixed namespace for Bindery vocabulary identities (UUID v5-style, SHA-1).
const NAMESPACE = Buffer.from("6f9619ff8b86d011b42d00c04fc964ff", "hex");

function uuidV5(name: string): string {
  const hash = createHash("sha1").update(NAMESPACE).update(Buffer.from(name, "utf8")).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Device + raw word + lookup time, or the device's own lookup id, is stable across re-syncs. */
export function vocabularyId(deviceId: string, rawWord: string, lookedUpAt: string, lookupId: string | null = null): string {
  return uuidV5(lookupId === null ? `${deviceId}\u0000word\u0000${rawWord}\u0000${lookedUpAt}` : `${deviceId}\u0000lookup\u0000${lookupId}`);
}
