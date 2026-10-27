import { EditorSkeleton } from "../ui/skeleton";
import { createFileRoute, redirect } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../server/functions";
import { RulesPage } from "../features/catalog/rules";
import { legacyThemeRedirect, legacyThemeTarget } from "../features/catalog/settings-redirects";
import { authenticatedRoute } from "../server/http";

const loadCatalog = createServerFn({ method: "GET" }).middleware([authenticated])
  .validator((input: Record<string, string>) => input)
  .handler(async ({ context, data }) => (await import("../server/catalog/templates")).catalogPage({ ...data, tab: "parsing" }, context.library));
export const Route = createFileRoute("/_app/rules")({
  pendingComponent: EditorSkeleton,
  beforeLoad: ({ location }) => { const target = legacyThemeRedirect(location.href); if (target) throw redirect(target); },
  server: { handlers: { GET: context => {
    const target = legacyThemeTarget(context.request.url);
    if (!target) return context.next();
    return authenticatedRoute(() => new Response(null, { status: 308, headers: { Location: target } }))(context);
  } } },
  validateSearch: (search: Record<string, unknown>) => Object.fromEntries(Object.entries(search).map(([key, value]) => [key, String(value ?? "")])),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => loadCatalog({ data: deps }),
  head: () => ({ meta: [{ title: "切章规则 · Bindery" }] }),
  component: Page,
});
function Page() { const data = Route.useLoaderData(); return <RulesPage data={data()} />; }

