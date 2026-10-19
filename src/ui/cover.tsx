import { createSignal, Show } from "solid-js";

export function coverTone(bookId: string): number {
  const prefix = bookId.slice(0, 2);
  return (/^[\da-f]{1,2}$/i.test(prefix) ? parseInt(prefix, 16) : 0) % 5;
}
export interface CoverProps { book_id: string; title: string; author?: string | null; compact?: boolean; class?: string }
export function GeneratedCover(props: CoverProps) {
  return <div class={`cover cover-gen cover-tone-${coverTone(props.book_id)} ${props.compact ? "cover-compact" : ""} ${props.class || ""}`} role="img" aria-label={props.title}>
    <div class="cover-gen-inner"><div><div class="cover-gen-rule" /><div class="cover-gen-title">{props.title}</div><div class="cover-gen-char">{Array.from(props.title)[0] || ""}</div></div><div class="cover-gen-author">{props.author || ""}</div></div>
  </div>;
}
export function BookCover(props: CoverProps & { cover_url?: string | null; eager?: boolean }) {
  const [failedUrl, setFailedUrl] = createSignal<string | null>(null);
  return <Show when={props.cover_url && props.cover_url !== failedUrl()} fallback={<GeneratedCover {...props} />}>
    <div class={`cover ${props.class || ""}`}><img src={props.cover_url!} alt={props.title} loading={props.eager ? "eager" : "lazy"} onError={() => setFailedUrl(props.cover_url || null)} /></div>
  </Show>;
}
