import type { JSX } from "@solidjs/web";
export function EmptyState(props: { title?: string; children?: JSX.Element; action?: JSX.Element }) {
  return <div class="empty-state"><h2>{props.title || "暂无内容"}</h2><div class="muted">{props.children}</div>{props.action}</div>;
}
