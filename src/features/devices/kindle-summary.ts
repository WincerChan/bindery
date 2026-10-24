import type { PairedDevice } from "../../client/devices/identity";

/** `skipped`: unreadable on the device; `missing`: transferred from a library that does not have the book. */
export interface KindleAutoSyncResult { synced: number; skipped: number; missing: number; marked_read: number; unchanged: number; kept: number; unmatched: number; vocabulary?: number; vocabulary_skipped?: number }
export type KindleReadingSync = (device: PairedDevice) => Promise<KindleAutoSyncResult>;
export function kindleReadingSummary(result: KindleAutoSyncResult): string {
  const parts = [`已同步 ${result.synced + result.unchanged} 本书的阅读进度`];
  if (result.skipped) parts.push(`${result.skipped} 本无法读取`);
  if (result.missing) parts.push(`${result.missing} 本不在书库中`);
  if (result.kept) parts.push(`${result.kept} 本设备进度较旧，已保留之前的记录`);
  if (result.vocabulary) parts.push(`同步 ${result.vocabulary} 个生词`);
  return parts.join(" · ");
}
