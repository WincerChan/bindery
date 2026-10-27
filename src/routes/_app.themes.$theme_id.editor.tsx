import { EditorSkeleton } from "../ui/skeleton";
import { loadOrNotFound } from "../shared/not-found";
import { NotFoundPage } from "../shared/not-found-page";
import { createFileRoute } from "@tanstack/solid-router";
import { Show } from "solid-js";
import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../server/functions";
import { authenticatedRoute } from "../server/http";
import { RulesPage } from "../features/catalog/rules";

const loadEditor = createServerFn({ method: "GET" }).middleware([authenticated])
  .validator((input: string) => input)
  .handler(async ({ data, context }) => {
    const catalog = await import("../server/catalog/templates");
    catalog.themeEditor(data);
    return catalog.catalogPage({ tab: "themes", theme_id: data }, context.library);
  });
export const Route = createFileRoute("/_app/themes/$theme_id/editor")({
  pendingComponent: EditorSkeleton,
  loader: ({ params }) => loadOrNotFound(() => loadEditor({ data: params.theme_id })),
  server: { handlers: { POST: authenticatedRoute<{ theme_id: string }>(async context => (await import("../server/catalog/http")).saveEditorHandler("themes")(context)) } },
  head: () => ({ meta: [{ title: "主题编辑 · Bindery" }] }),
  component: Page,
  notFoundComponent: NotFoundPage,
});
function Page() { const data = Route.useLoaderData(); return <Show when={data()} keyed>{page => <RulesPage data={page} />}</Show>; }

