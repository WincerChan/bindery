import { DeviceBodySkeleton } from "../ui/skeleton";
import { createFileRoute } from "@tanstack/solid-router";
import { VocabularyPage } from "../features/devices/vocabulary";
import { getLexiTraceSettings, listVocabulary, retryVocabularyPush, saveLexiTraceSettings, testLexiTraceConnection } from "../server/vocabulary/functions";

export const Route = createFileRoute("/_app/devices/vocabulary")({
  pendingComponent: DeviceBodySkeleton,
  loader: async () => {
    const [page, settings] = await Promise.all([listVocabulary({ data: {} }), getLexiTraceSettings()]);
    return { page, settings };
  },
  head: () => ({ meta: [{ title: "生词本 · 设备 · Bindery" }] }),
  component: VocabularyRoute,
});

function VocabularyRoute() {
  const data = Route.useLoaderData();
  return <VocabularyPage initial={data().page} initialSettings={data().settings} api={{
    list: () => listVocabulary({ data: {} }),
    retry: ids => retryVocabularyPush({ data: ids ? { ids } : {} }),
    saveSettings: input => saveLexiTraceSettings({ data: input }),
    testConnection: input => testLexiTraceConnection({ data: input }),
  }} />;
}
