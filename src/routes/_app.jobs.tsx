import { createFileRoute, redirect } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";
import { legacyJobsTarget } from "../features/ingest/search";

export const Route = createFileRoute("/_app/jobs")({
  beforeLoad: ({ location }) => { throw redirect({ href: legacyJobsTarget(location.searchStr), replace: true }); },
  server: { handlers: { GET: authenticatedRoute(({ request }) => new Response(null, { status: 303, headers: { Location: legacyJobsTarget(new URL(request.url).search) } })) } },
});
