import { createFileRoute, redirect } from "@tanstack/solid-router";
import { legacyVocabularyRedirect, legacyVocabularyTarget } from "../features/devices/redirects";
import { authenticatedRoute } from "../server/http";

export const Route = createFileRoute("/_app/devices/vocabulary")({
  beforeLoad: ({ location }) => { throw redirect(legacyVocabularyRedirect(location.href)); },
  server: { handlers: { GET: authenticatedRoute(({ request }) => {
    const url = new URL(request.url);
    return new Response(null, { status: 308, headers: { Location: legacyVocabularyTarget(url.pathname + url.search) } });
  }) } },
});
