import type { PairedDevice } from "../../client/devices/identity";

export interface KoboAutoSyncResult { synced: number; skipped: number; marked_read: number; unchanged: number; lagged: boolean; unmatched: number }
export type KoboReadingSync = (device: PairedDevice) => Promise<KoboAutoSyncResult>;
export function koboReadingSummary(result: KoboAutoSyncResult): string {
  const parts = [`已同步 ${result.synced + result.unchanged} 本书的阅读进度`];
  if (result.marked_read) parts.push(`${result.marked_read} 本标为已读`);
  if (result.unmatched) parts.push(`${result.unmatched} 本未匹配到书库`);
  if (result.lagged) parts.push("Kobo 阅读数据可能滞后");
  return parts.join(" · ");
}
