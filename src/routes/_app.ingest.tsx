import { createFileRoute } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../server/functions";
import { authenticatedRoute } from "../server/http";
import { IngestPage } from "../features/ingest/page";
import "../features/ingest/ingest.css";
const loadIngest = createServerFn({ method: "GET" }).middleware([authenticated]).handler(async () => (await import("../server/ingest/queries")).ingestOptions());
export const Route = createFileRoute("/_app/ingest")({
  loader: () => loadIngest(), head: () => ({ meta: [{ title: "入库 · Bindery" }] }),
  server: { handlers: { POST: authenticatedRoute(async ({ request, library }) => {
    const parsed = await (await import("../server/ingest/multipart")).uploadForm(request, library);
    try {
    const result = await (await import("../server/ingest/actions")).submitUploads(library, parsed.form, request);
    if (result instanceof Response) return result;
    if (request.headers.get("Accept")?.includes("application/json")) return Response.json(result);
    return new Response((await import("../server/ingest/render")).renderIngestError(result), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    } finally { parsed.cleanup(); }
  }) } },
  component: () => <IngestPage options={Route.useLoaderData()()} />,
});
