import { createFileRoute, notFound } from "@tanstack/solid-router";
import { Show } from "solid-js";
import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../server/functions";
import { authenticatedRoute } from "../server/http";
import { Editor } from "../features/catalog/editors";
import "../features/catalog/catalog.css";

const loadEditor = createServerFn({ method: "GET" }).middleware([authenticated])
  .inputValidator((input: string) => input)
  .handler(async ({ data }) => {
    const catalog = await import("../server/catalog/templates");
    try { return catalog.themeEditor(data); }
    catch (error) { if (error instanceof Error && "status" in error && error.status === 404) return null; throw error; }
  });
export const Route = createFileRoute("/_app/themes/$theme_id/editor")({
  loader: async ({ params }) => { const data = await loadEditor({ data: params.theme_id }); if (!data) throw notFound(); return data; },
  server: { handlers: { POST: authenticatedRoute<{ theme_id: string }>(async context => (await import("../server/catalog/http")).saveEditorHandler("themes")(context)) } },
  head: () => ({ meta: [{ title: "主题编辑 · Bindery" }] }),
  component: Page,
  notFoundComponent: () => <p role="alert">Theme not found</p>,
});
function Page() { const data = Route.useLoaderData(); return <div class="catalog-page"><p><a href="/rules?tab=themes">← 规则与主题</a></p><Show when={data()} keyed>{editor => <Editor kind="themes" data={editor} />}</Show></div>; }

