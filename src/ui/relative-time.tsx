import { createSignal, onSettled } from "solid-js";

type RelativeTimeOptions = { format?: "calendar" | "elapsed"; clampFuture?: boolean; invalidFallback?: string };
const pad = (value: number) => String(value).padStart(2, "0");
/** Calendar-aware local copy, with a deterministic UTC fallback before hydration. */
export function relativeTimeLabel(value: string, now?: Date, options: RelativeTimeOptions = {}): string {
  const date = new Date(value), time = date.getTime();
  if (!Number.isFinite(time)) return options.invalidFallback ?? "";
  if (!now) return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const elapsed = options.clampFuture ? Math.max(0, now.getTime() - time) : now.getTime() - time;
  if (elapsed >= 0 && elapsed < 60_000) return "刚刚";
  if (elapsed >= 0 && elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (options.format === "elapsed") {
    if (elapsed >= 0 && elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  } else {
    const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (date >= today && date <= now) return `今天 ${clock}`;
    if (date >= yesterday && date < today) return `昨天 ${clock}`;
  }
  if (elapsed >= 0 && elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)} 天前`;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
export function RelativeTime(props: RelativeTimeOptions & { value: string; class?: string; labelPrefix?: string }) {
  const [now, setNow] = createSignal<Date>();
  onSettled(() => { setNow(new Date()); });
  const label = () => relativeTimeLabel(props.value, now(), props);
  return <time datetime={props.value} title={props.value} class={props.class} aria-label={props.labelPrefix ? `${props.labelPrefix} ${label()}` : undefined}>{label()}</time>;
}
