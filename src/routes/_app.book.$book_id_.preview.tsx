import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";
import { previewRedirect } from "../server/reader/service";
const first = authenticatedRoute<{ book_id: string }>(({ request, params, library }) => previewRedirect(request, params.book_id, library));
export const Route = createFileRoute("/_app/book/$book_id_/preview")({ server: { handlers: { GET: first } } });
