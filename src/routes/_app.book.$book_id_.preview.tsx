import { createFileRoute, redirect } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";
import { previewRedirect } from "../server/reader/service";
import { readerEntryHref } from "../features/reader/model";
const first = authenticatedRoute<{ book_id: string }>(({ request, params, library }) => previewRedirect(request, params.book_id, library));
export const Route = createFileRoute("/_app/book/$book_id_/preview")({
  server: { handlers: { GET: first } },
  // In-app links never reach the server handler, so resume from the same target on the client.
  beforeLoad: ({ params, location }) => { throw redirect({ href: readerEntryHref(params.book_id, new URLSearchParams(location.searchStr).get("return_to")), replace: true }); },
});
