import { For, Show } from "solid-js";
import { RelativeTime } from "../../ui";
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
/** CJK titles take 「《…》」; Latin titles stay plain and are set in the Latin serif. */
export function BookTitle(props: { title: string }) {
  return <Show when={/[\u3400-\u9fff]/.test(props.title)} fallback={<>{' '}<SourceTitle title={props.title} /></>}>《{props.title}》</Show>;
}
export function WordSource(props: { item: Pick<VocabularyItem, "book_title" | "device_name" | "looked_up_at"> }) {
  return <span class="vocab-source"><Show when={props.item.book_title}><SourceTitle title={props.item.book_title} /></Show><Show when={props.item.book_title && props.item.device_name}> · </Show>{props.item.device_name}<Show when={props.item.looked_up_at}><Show when={props.item.book_title || props.item.device_name}> · </Show><RelativeTime value={props.item.looked_up_at} /></Show></span>;
}
