import { For, Show, createSignal, onSettled } from "solid-js";
import type { VocabularyItem } from "../../server/vocabulary/query";

/** Only the browser knows the reader's timezone. SSR deliberately omits this. */
export function vocabularyMonthQuery(now = new Date()): { month_start?: string } {
  return typeof window === "undefined" ? {} : { month_start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString() };
}

export function sentenceParts(sentence: string, raw: string, word: string): { text: string; highlighted: boolean }[] {
  // Prefer the actual inflection, then the normalized word. Escape all user text;
  // Unicode boundaries avoid highlighting “he” inside “the” without excluding CJK.
  for (const candidate of [raw.trim().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, ""), word.trim()]) {
    if (!candidate) continue;
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const latin = /^[\p{Script=Latin}\p{M}'’\s-]+$/u.test(candidate);
    const pattern = new RegExp(latin ? `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])` : escaped, "giu");
    const matches = [...sentence.matchAll(pattern)];
    if (!matches.length) continue;
    const parts: { text: string; highlighted: boolean }[] = [];
    let cursor = 0;
    for (const match of matches) {
      if (match.index > cursor) parts.push({ text: sentence.slice(cursor, match.index), highlighted: false });
      parts.push({ text: match[0], highlighted: true }); cursor = match.index + match[0].length;
    }
    if (cursor < sentence.length) parts.push({ text: sentence.slice(cursor), highlighted: false });
    return parts;
  }
  return [{ text: sentence, highlighted: false }];
}
export function HighlightedSentence(props: { sentence: string; raw: string; word: string }) {
  return <For each={sentenceParts(props.sentence, props.raw, props.word)}>{part => <Show when={part.highlighted} fallback={part.text}><mark>{part.text}</mark></Show>}</For>;
}
export function SourceTitle(props: { title: string }) {
  return <span class={/[A-Za-z]/.test(props.title) ? "vocab-latin-title" : undefined}>{props.title}</span>;
}
export function relativeLookupTime(value: string, now: Date): string {
  const date = new Date(value), elapsed = now.getTime() - date.getTime();
  if (!Number.isFinite(date.getTime())) return "";
  if (elapsed >= 0 && elapsed < 60_000) return "刚刚";
  if (elapsed >= 0 && elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  const clock = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (date >= today && date <= now) return `今天 ${clock}`;
  if (date >= yesterday && date < today) return `昨天 ${clock}`;
  if (elapsed >= 0 && elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)} 天前`;
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function LookupTime(props: { value: string }) {
  // Stable SSR/hydration output, localized only after the client has settled.
  const [now, setNow] = createSignal<Date | null>(null);
  onSettled(() => { setNow(new Date()); });
  return <time datetime={props.value} title={props.value}>{now() ? relativeLookupTime(props.value, now()!) : props.value.slice(5, 10)}</time>;
}
export function WordSource(props: { item: Pick<VocabularyItem, "book_title" | "device_name" | "looked_up_at"> }) {
  return <span class="vocab-source"><Show when={props.item.book_title}><SourceTitle title={props.item.book_title} /></Show><Show when={props.item.book_title && props.item.device_name}> · </Show>{props.item.device_name}<Show when={props.item.looked_up_at}><Show when={props.item.book_title || props.item.device_name}> · </Show><LookupTime value={props.item.looked_up_at} /></Show></span>;
}
