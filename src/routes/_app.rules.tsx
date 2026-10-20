import { createFileRoute } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../server/functions";
import { RulesPage } from "../features/catalog/rules";
import "../features/catalog/catalog.css";

const loadCatalog = createServerFn({ method: "GET" }).middleware([authenticated])
  .validator((input: Record<string, string>) => input)
  .handler(async ({ data }) => (await import("../server/catalog/templates")).catalogPage(data));
export const Route = createFileRoute("/_app/rules")({
  validateSearch: (search: Record<string, unknown>) => Object.fromEntries(Object.entries(search).map(([key, value]) => [key, String(value ?? "")])),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => loadCatalog({ data: deps }),
  head: () => ({ meta: [{ title: "规则 · Bindery" }] }),
  component: Page,
});
function Page() { const data = Route.useLoaderData(); return <RulesPage data={data()} />; }

