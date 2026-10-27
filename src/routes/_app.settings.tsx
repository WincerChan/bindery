import { createFileRoute } from "@tanstack/solid-router";
import { SettingsHub } from "../features/settings/hub";
import { loadSettingsSummary } from "../server/settings/functions";

export const Route = createFileRoute("/_app/settings")({
  loader: async () => ({ summary: await loadSettingsSummary(), now: Date.now() }),
  head: () => ({ meta: [{ title: "设置 · Bindery" }] }),
  component: SettingsRoute,
});
function SettingsRoute() {
  const data = Route.useLoaderData();
  return <SettingsHub summary={data().summary} now={data().now} />;
}
