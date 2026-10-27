import { render, renderToString } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { VocabularyPage, filterVocabularyItems, pushStatusLabel } from "../../../src/features/vocabulary/vocabulary";
import type { VocabularyApi } from "../../../src/features/vocabulary/vocabulary";
export { sentenceParts, vocabularyMonthQuery } from "../../../src/features/vocabulary/display";
export { relativeTimeLabel as relativeLookupTime } from "../../../src/ui/relative-time";
import type { VocabularyItem, VocabularyPage as PageData } from "../../../src/server/vocabulary/query";
import type { LexiTraceSettingsView } from "../../../src/server/vocabulary/settings";

export { filterVocabularyItems, pushStatusLabel };
export function dataFor(items: VocabularyItem[]): PageData {
  const choices = (key: "book_key" | "device_id", label: "book_title" | "device_name") => [...new Set(items.map(item => item[key]))].map(value => ({ key: value, label: items.find(item => item[key] === value)![label], count: items.filter(item => item[key] === value).length }));
  return { items, devices: choices("device_id", "device_name"), books: choices("book_key", "book_title"), summary: {
    total: items.length,
    month: { since: "2026-10-01T00:00:00.000Z", count: 0, top_source: null },
    push: {
      pushed: items.filter(value => value.push_state === "pushed").length,
      failed: items.filter(value => value.push_state === "error" || value.push_state === "conflict").length,
      pending: items.filter(value => value.push_state === "pending").length,
    },
    latest: items[0] ?? null,
  }, totals: {
    all: items.length,
    pending: items.filter(value => value.push_state === "pending").length,
    pushed: items.filter(value => value.push_state === "pushed").length,
    conflict: items.filter(value => value.push_state === "conflict").length,
    error: items.filter(value => value.push_state === "error").length,
  } };
}
export function page(items: VocabularyItem[], settings: LexiTraceSettingsView, summary?: PageData["summary"]): string {
  const data = dataFor(items);
  if (summary) data.summary = summary;
  const api = {
    list: async () => data,
    retry: async () => ({ retried: 1, page: data }),
    saveSettings: async () => settings,
    testConnection: async () => ({ ok: true, status: 404, latencyMs: 12 }),
  };
  return renderToString(() => <VocabularyPage initial={data} initialSettings={settings} api={api} />);
}
export function mount(node: HTMLElement, data: PageData, settings: LexiTraceSettingsView, api: VocabularyApi, open = false) {
  const [settingsOpen, setSettingsOpen] = createSignal(open);
  const dispose = render(() => <VocabularyPage initial={data} initialSettings={settings} settingsOpen={settingsOpen()} api={api} />, node);
  flush();
  return { dispose, flush, setSettingsOpen };
}
