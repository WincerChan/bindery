import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";
import { bookCoverResponse } from "../server/files";

const serve = authenticatedRoute<{ book_id: string }>(({ request, params, library }) => bookCoverResponse(request, params.book_id, library));
export const Route = createFileRoute("/book/$book_id/cover")({
  server: { handlers: { GET: serve, HEAD: serve } },
});
