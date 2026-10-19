import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";
import { bookDownloadResponse } from "../server/files";

const serve = authenticatedRoute<{ book_id: string }>(({ request, params, library }) => bookDownloadResponse(request, params.book_id, library));
export const Route = createFileRoute("/book/$book_id/download")({
  server: { handlers: { GET: serve, HEAD: serve } },
});
