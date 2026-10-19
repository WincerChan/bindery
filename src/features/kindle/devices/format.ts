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
