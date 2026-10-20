import { KINDLE_MODELS, type KindleModel } from "../../../client/kindle";
export function bytes(size: number) {
  const units = ["B", "KB", "MB", "GB"], power = Math.min(3, Math.floor(Math.log(Math.max(1, size)) / Math.log(1024)));
  return `${(size / 1024 ** power).toLocaleString("zh-CN", { maximumFractionDigits: power ? 1 : 0 })} ${units[power]}`;
}
export function modelLabel(model: KindleModel) {
  const m = KINDLE_MODELS[model];
  return `${m.name}${m.width ? ` · ${m.width}×${m.height} · ${m.ppi} ppi · ${m.inches}″` : ""}`;
}
export const dateLabel = (date: string | null) => date ? new Date(date).toLocaleString("zh-CN", { hour12: false }) : "—";
export const megabytes = (value: number) => (value / (1024 * 1024)).toLocaleString("zh-CN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export function byteProgressDetail(label: string, progress: { loaded?: number; total?: number; bytesPerSecond?: number; etaSeconds?: number }) {
  const amount = progress.total === undefined ? `${megabytes(progress.loaded ?? 0)} MB（总大小未知）` : `${megabytes(progress.loaded ?? 0)} / ${megabytes(progress.total)} MB`;
  const rate = progress.bytesPerSecond === undefined ? "" : ` · ${megabytes(progress.bytesPerSecond)} MB/s`;
  const eta = progress.etaSeconds === undefined ? "" : ` · 剩余约 ${Math.ceil(progress.etaSeconds)} 秒`;
  return `${label} ${amount}${rate}${eta}`;
}
