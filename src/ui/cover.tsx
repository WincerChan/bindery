import { createSignal, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { IconButton, ProgressBar } from "./primitives";

/** Stable across renders and platforms; no runtime/random color sampling. */
export function coverTone(bookId: string): number {
  if (/^[\da-f]+$/i.test(bookId)) return parseInt(bookId.slice(0, 8), 16) % 13;
  let hash = 0;
  for (const character of bookId) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return hash % 13;
}
export type CoverState = "read" | "reading" | "failed" | "generating" | "not-in-library" | "duplicate" | "unparseable";
export const coverStateLabel: Record<CoverState, string> = {
  read: "已读", reading: "在读", failed: "生成失败，点击查看并重试", generating: "生成中", "not-in-library": "未入库", duplicate: "疑似重复", unparseable: "无法解析",
};
export interface CoverProps {
  book_id: string; title: string; author?: string | null; compact?: boolean; class?: string;
  dynasty?: string; large?: boolean; state?: CoverState; progress?: number;
  /** Interactive retry covers must not be placed inside a link/button. Otherwise use the book menu. */
  onRetry?: () => void;
}
function CoverFrame(props: CoverProps & { children: JSX.Element; generated?: boolean }) {
  const label = () => `${props.title}${props.state ? `（${coverStateLabel[props.state]}）` : ""}`;
  return <div class={`cover ${props.generated ? `cover-gen cover-tone-${coverTone(props.book_id)}` : ""} ${props.compact ? "cover-compact" : ""} ${props.large ? "cover-large" : ""} ${props.state ? `cover-${props.state}` : ""} ${props.class || ""}`}>
    <div class="cover-art" role="img" aria-label={label()}>{props.children}</div>
    <Show when={props.state === "read" || props.state === "reading"}><span class="cover-ribbon" aria-hidden="true" /></Show>
    <Show when={props.state === "failed"}><Show when={props.onRetry} fallback={<span class="cover-retry" aria-hidden="true">↻</span>}>
      {retry => <IconButton class="cover-retry" aria-label={`重试生成《${props.title}》`} title={`重试生成《${props.title}》`} onClick={() => retry()()}>↻</IconButton>}
    </Show></Show>
    <Show when={props.state === "duplicate" || props.state === "unparseable"}><span class="cover-marker" aria-hidden="true">{props.state === "duplicate" ? "⧉" : "!"}</span></Show>
    <Show when={props.state === "generating" || props.progress !== undefined}><ProgressBar label={`${props.title} ${props.state === "generating" ? "生成" : "阅读"}进度`} value={props.progress} class="cover-progress" /></Show>
  </div>;
}
export function GeneratedCover(props: CoverProps) {
  return <CoverFrame {...props} generated><div class="cover-gen-inner"><div class="cover-gen-era">{props.dynasty || "藏书"}</div><div class="cover-gen-title">{props.title}</div><div class="cover-gen-author">{props.author || ""}</div></div></CoverFrame>;
}
export function BookCover(props: CoverProps & { cover_url?: string | null; eager?: boolean }) {
  const [failedUrl, setFailedUrl] = createSignal<string | null>(null);
  return <Show when={props.cover_url && props.cover_url !== failedUrl() && props.state !== "not-in-library" && props.state !== "unparseable"} fallback={<GeneratedCover {...props} />}>
    <CoverFrame {...props}><img src={props.cover_url!} alt={props.title} loading={props.eager ? "eager" : "lazy"} onError={() => setFailedUrl(props.cover_url || null)} /></CoverFrame>
  </Show>;
}
export function AddCoverTile(props: { label: string; onClick: () => void; class?: string }) {
  return <button type="button" class={`cover-add ${props.class || ""}`} aria-label={props.label} title={props.label} onClick={props.onClick}><span aria-hidden="true">＋</span><span>{props.label}</span></button>;
}
