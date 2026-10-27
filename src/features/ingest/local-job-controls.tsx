import { createSignal, For, onSettled } from "solid-js";
import { CountBadge } from "../../ui";
import { Link } from "../../shared/spa-link";
import type { JobsPayload } from "../../server/ingest/queries";

// SegmentedControl only supports buttons; these tabs must retain real query links.
export function IngestJobTabs(props: { data: JobsPayload }) {
  return <nav aria-label="任务分组" class="ingest-job-tabs"><For each={props.data.tabs}>{tab => <Link replace resetScroll={false} hashScrollIntoView={false} href={`/ingest?jobs_tab=${tab.key}&jobs_page=1#jobs`} aria-current={props.data.active_tab === tab.key ? "page" : undefined}>{tab.label} · <CountBadge accent={props.data.active_tab === tab.key}>{tab.count}</CountBadge></Link>}</For></nav>;
}

// LocalTime deliberately uses absolute dates; jobs need the design's relative copy.
export function IngestJobTime(props: { value: string }) {
  const [now, setNow] = createSignal<number | null>(null);
  onSettled(() => { setNow(Date.now()); });
  const text = () => {
    const date = new Date(props.value), time = date.getTime();
    if (!Number.isFinite(time)) return props.value;
    if (now() === null) return `${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
    const age = Math.max(0, now()! - time), days = Math.floor(age / 86_400_000);
    if (age < 60_000) return "刚刚";
    if (age < 3_600_000) return `${Math.floor(age / 60_000)} 分钟前`;
    if (age < 86_400_000) return `${Math.floor(age / 3_600_000)} 小时前`;
    if (days < 7) return `${days} 天前`;
    return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  return <time datetime={props.value} title={props.value}>{text()}</time>;
}
