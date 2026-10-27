import { DeviceBodySkeleton } from "../ui/skeleton";
import { createFileRoute } from "@tanstack/solid-router";
import { VocabularyPage } from "../features/vocabulary/vocabulary";
import { vocabularyMonthQuery } from "../features/vocabulary/display";
import { getLexiTraceSettings, listVocabulary, retryVocabularyPush, saveLexiTraceSettings, testLexiTraceConnection } from "../server/vocabulary/functions";

export const Route = createFileRoute("/_app/vocabulary")({
  validateSearch: (search: Record<string, unknown>) => ({ settings: search.settings === "lexitrace" ? "lexitrace" : undefined }),
  pendingComponent: DeviceBodySkeleton,
  loader: async () => {
    const [page, settings] = await Promise.all([listVocabulary({ data: vocabularyMonthQuery() }), getLexiTraceSettings()]);
    return { page, settings };
  },
  head: () => ({ meta: [{ title: "生词本 · Bindery" }] }),
  component: VocabularyRoute,
});

function VocabularyRoute() {
  const data = Route.useLoaderData(), search = Route.useSearch();
  return <VocabularyPage initial={data().page} initialSettings={data().settings} settingsOpen={search().settings === "lexitrace"} api={{
    list: input => listVocabulary({ data: input }),
    retry: ids => retryVocabularyPush({ data: ids ? { ids } : {} }),
    saveSettings: input => saveLexiTraceSettings({ data: input }),
    testConnection: input => testLexiTraceConnection({ data: input }),
  }} />;
}
