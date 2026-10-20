import { createFileRoute } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../server/functions";
import { jobsSearch } from "../features/ingest/search";
import { authenticatedRoute, HttpError } from "../server/http";
import { IngestScreen } from "../features/ingest/screen";
import "../features/ingest/ingest.css";
const loadIngest = createServerFn({ method: "GET" }).middleware([authenticated]).inputValidator(jobsSearch).handler(async ({ context, data }) => {
  if (data.invalid) throw new HttpError(422, "Input should be a valid integer");
  const { ingestOptions, jobsPayload } = await import("../server/ingest/queries");
  return { options: ingestOptions(), jobs: jobsPayload(context.library, data.tab, data.page) };
});
export const Route = createFileRoute("/_app/ingest")({
  validateSearch: (search: Record<string, unknown>) => search,
  loaderDeps: ({ search }) => search,
  loader: ({ location }) => loadIngest({ data: Object.fromEntries(new URLSearchParams(location.searchStr)) }), head: () => ({ meta: [{ title: "入库 · Bindery" }] }),
  server: { handlers: { GET: async context => {
    if (!jobsSearch(Object.fromEntries(new URL(context.request.url).searchParams)).invalid) return context.next();
    return authenticatedRoute(() => { throw new HttpError(422, "Input should be a valid integer"); })(context);
  }, POST: authenticatedRoute(async ({ request, library }) => {
    const parsed = await (await import("../server/ingest/multipart")).uploadForm(request, library);
    try {
    const result = await (await import("../server/ingest/actions")).submitUploads(library, parsed.form, request);
    if (result instanceof Response) return result;
    if (request.headers.get("Accept")?.includes("application/json")) return Response.json(result);
    return new Response((await import("../server/ingest/render")).renderIngestError(result, (await import("../server/ingest/queries")).jobsPayload(library)), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    } finally { parsed.cleanup(); }
  }) } },
  component: Ingest,
});
function Ingest() {
  const data = Route.useLoaderData();
  return <IngestScreen data={data()} />;
}
