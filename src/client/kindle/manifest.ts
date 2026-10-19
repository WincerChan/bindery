import { entryName, isMissing, readJson, writeBytes, type KindleDirectory } from "./fs";

export interface ManifestBook {
  book_id: string; filename: string; content_id: string; cde_content_type: "EBOK" | "PDOC";
  profile_id: string; profile_name: string; transferred_at: string; size: number;
  thumbnail: string | null;
}
export interface DeviceManifest { version: 1; books: ManifestBook[] }
export const thumbnailName = (id: string, type: "EBOK" | "PDOC") => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("无效的 KFX content ID");
  return `thumbnail_${id}_${type}_portrait.jpg`;
};
export function parseManifest(value: unknown): DeviceManifest {
  const v = value as DeviceManifest | null;
  if (!v || v.version !== 1 || !Array.isArray(v.books)) throw new Error("Kindle 传输记录损坏，请检查 .bindery/manifest.json");
  const filenames = new Set<string>();
  for (const b of v.books) {
    if (!b || typeof b.filename !== "string" || entryName(b.filename) !== b.filename || !b.filename.toLowerCase().endsWith(".kfx") || filenames.has(b.filename.toLowerCase()) || typeof b.book_id !== "string" || !b.book_id || typeof b.content_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(b.content_id) || !["EBOK", "PDOC"].includes(b.cde_content_type) || typeof b.profile_id !== "string" || typeof b.profile_name !== "string" || !Number.isFinite(Date.parse(b.transferred_at)) || !Number.isSafeInteger(b.size) || b.size < 0 || b.thumbnail !== null && b.thumbnail !== thumbnailName(b.content_id, b.cde_content_type)) throw new Error("Kindle 传输记录包含无效条目");
    filenames.add(b.filename.toLowerCase());
  }
  return structuredClone(v);
}
export async function readManifest(root: KindleDirectory): Promise<DeviceManifest> {
  await root.getDirectoryHandle("documents");
  try { return parseManifest(await readJson(await root.getDirectoryHandle(".bindery"), "manifest.json")); }
  catch (error) { if (isMissing(error)) { await root.getDirectoryHandle("documents"); return { version: 1, books: [] }; } throw error; }
}
export const manifestBytes = (manifest: DeviceManifest) => JSON.stringify(parseManifest(manifest), null, 2);
/** For pairing/import tools. Device mutations use transaction.ts instead. */
export async function writeManifest(root: KindleDirectory, manifest: DeviceManifest) {
  await writeBytes(await root.getDirectoryHandle(".bindery", { create: true }), "manifest.json", manifestBytes(manifest));
}
