import { GeneratedCover } from "../../ui";
import type { TrackerItem } from "../../server/catalog/tracker";

export const trackerReadOptions = [{ value: "unread", label: "未读" }, { value: "reading", label: "在读" }, { value: "read", label: "已读" }];
export const trackerStatusOptions = [{ value: "ongoing", label: "更新中" }, { value: "hiatus", label: "已断更" }, { value: "completed", label: "已完结" }];
export const trackerBookHref = (wish: TrackerItem, next: string) => `/book/${wish.library_book_id}?return_to=${encodeURIComponent(next)}`;
export const trackerState = (wish: TrackerItem) => [wish.read_status_label, !wish.exists_in_library && "未入库"].filter(Boolean).join(" · ");
export const trackerStateTone = (wish: TrackerItem) => wish.read_status === "read" ? "ok" as const : wish.read_status === "reading" ? "accent" as const : "empty" as const;
export const trackerRowMeta = (wish: TrackerItem) => [wish.book_status === "completed" ? "" : wish.book_status_label, wish.tags.join("、")].filter(Boolean).join(" · ");

/** Tracker can be both read and not in the library; keep that composition here. */
export function TrackerCover(props: { wish?: TrackerItem; title?: string; author?: string; compact?: boolean; large?: boolean }) {
  return <div class={Array.from(props.title ?? props.wish?.title ?? "书名").length > 4 ? "tracker-cover-long-title" : undefined} role="img" aria-label={`${props.title ?? props.wish?.title ?? "书名"}（${props.wish ? trackerState(props.wish) : "未入库"}）`}><div aria-hidden="true"><GeneratedCover book_id={props.wish?.library_book_id || props.wish?.id || "tracker-new"} title={props.title ?? props.wish?.title ?? "书名"} author={props.author ?? props.wish?.author}
    dynasty={props.wish?.book_status === "ongoing" ? "连载" : undefined} compact={props.compact} large={props.large}
    state={props.wish?.read_status === "read" ? "read" : props.wish?.read_status === "reading" ? "reading" : !props.wish?.exists_in_library ? "not-in-library" : undefined}
    class={!props.wish?.exists_in_library ? "cover-not-in-library" : undefined} /></div></div>;
}
