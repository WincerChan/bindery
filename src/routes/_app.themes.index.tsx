import { createFileRoute } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../server/functions";
import { RulesPage } from "../features/catalog/rules";
import { EditorSkeleton } from "../ui";

const loadThemes = createServerFn({ method: "GET" }).middleware([authenticated])
  .validator((input: Record<string, string>) => input)
  .handler(async ({ context, data }) => (await import("../server/catalog/templates")).catalogPage({ ...data, tab: "themes" }, context.library));
export const Route = createFileRoute("/_app/themes/")({
  pendingComponent: EditorSkeleton,
  validateSearch: (search: Record<string, unknown>) => Object.fromEntries(Object.entries(search).map(([key, value]) => [key, String(value ?? "")])),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => loadThemes({ data: deps }),
  head: () => ({ meta: [{ title: "主题 · Bindery" }] }),
  component: Page,
});
function Page() { const data = Route.useLoaderData(); return <RulesPage data={data()} />; }
