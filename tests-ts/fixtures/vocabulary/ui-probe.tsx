import { renderToString } from "@solidjs/web";
import { VocabularyPage, filterVocabularyItems, pushStatusLabel } from "../../../src/features/devices/vocabulary";
import type { VocabularyItem, VocabularyPage as PageData } from "../../../src/server/vocabulary/query";
import type { LexiTraceSettingsView } from "../../../src/server/vocabulary/settings";

export { filterVocabularyItems, pushStatusLabel };
export function page(items: VocabularyItem[], settings: LexiTraceSettingsView): string {
  const data: PageData = { items, devices: [], books: [], totals: {
    all: items.length,
    pending: items.filter(value => value.push_state === "pending").length,
    pushed: items.filter(value => value.push_state === "pushed").length,
    conflict: items.filter(value => value.push_state === "conflict").length,
    error: items.filter(value => value.push_state === "error").length,
  } };
  const api = {
    list: async () => data,
    retry: async () => ({ retried: 1, page: data }),
    saveSettings: async () => settings,
    testConnection: async () => ({ ok: true, status: 404, latencyMs: 12 }),
  };
  return renderToString(() => <VocabularyPage initial={data} initialSettings={settings} api={api} />);
}
