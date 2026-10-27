import { createSignal, For, onSettled } from "solid-js";
import { Button, GeneratedCover } from "../../ui";
import type { TrackerItem } from "../../server/catalog/tracker";

export const trackerReadOptions = [{ value: "unread", label: "未读" }, { value: "reading", label: "在读" }, { value: "read", label: "已读" }];
export const trackerStatusOptions = [{ value: "ongoing", label: "更新中" }, { value: "hiatus", label: "已断更" }, { value: "completed", label: "已完结" }];
export const trackerBookHref = (wish: TrackerItem, next: string) => `/book/${wish.library_book_id}?return_to=${encodeURIComponent(next)}`;
export const trackerState = (wish: TrackerItem) => [wish.read_status_label, !wish.exists_in_library && "未入库"].filter(Boolean).join(" · ");

/** Shared covers currently accept one state; tracker can be both read and not in the library. */
export function LocalTrackerCover(props: { wish?: TrackerItem; title?: string; author?: string; compact?: boolean; large?: boolean }) {
  return <div role="img" aria-label={`${props.title ?? props.wish?.title ?? "书名"}（${props.wish ? trackerState(props.wish) : "未入库"}）`}><div aria-hidden="true"><GeneratedCover book_id={props.wish?.library_book_id || props.wish?.id || "tracker-new"} title={props.title ?? props.wish?.title ?? "书名"} author={props.author ?? props.wish?.author}
    dynasty={props.wish?.book_status === "ongoing" ? "连载" : undefined} compact={props.compact} large={props.large}
    state={props.wish?.read_status === "read" ? "read" : props.wish?.read_status === "reading" ? "reading" : !props.wish?.exists_in_library ? "not-in-library" : undefined}
    class={!props.wish?.exists_in_library ? "tracker-cover-out" : undefined} /></div></div>;
}
export function LocalTrackerStars(props: { rating: number }) {
  return <span class="tracker-stars" role="img" aria-label={`${props.rating} 星`}><For each={[1, 2, 3, 4, 5]}>{n => <span aria-hidden="true" class={n <= props.rating ? "tracker-star-filled" : undefined}>★</span>}</For></span>;
}
export function LocalTrackerRating(props: { value: string; onChange: (value: string) => void }) {
  return <fieldset class="tracker-rating"><legend>评分</legend><input type="hidden" name="rating" value={props.value} /><div>
    <For each={[1, 2, 3, 4, 5]}>{n => <Button variant="quiet" aria-label={`${n} 星`} aria-pressed={props.value === String(n) ? "true" : "false"} class={n <= Number(props.value) ? "tracker-star-filled" : "tracker-star-empty"} onClick={() => props.onChange(String(n))}><span aria-hidden="true">★</span></Button>}</For>
    <Button variant="quiet" aria-label="清除评分" onClick={() => props.onChange("")}>清除</Button>
  </div></fieldset>;
}

/** Stable UTC SSR fallback, then relative/local dates after hydration. */
export function LocalTrackerUpdated(props: { value: string }) {
  const [now, setNow] = createSignal<number>();
  onSettled(() => { setNow(Date.now()); });
  const label = () => {
    const date = new Date(props.value);
    if (!Number.isFinite(date.valueOf())) return "";
    const current = now();
    const pad = (n: number) => String(n).padStart(2, "0");
    if (current === undefined) return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    const elapsed = Math.max(0, current - date.valueOf());
    if (elapsed < 60_000) return "刚刚";
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
    const today = new Date(current); today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    if (date >= today) return `今天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    if (date >= yesterday) return `昨天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    if (elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)} 天前`;
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  };
  return <time datetime={props.value} title={props.value} aria-label={`更新于 ${label()}`}>{label()}</time>;
}
