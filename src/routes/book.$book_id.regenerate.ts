import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";
import { regenerateBook } from "../server/ingest/actions";
export const Route = createFileRoute("/book/$book_id/regenerate")({ server: { handlers: { POST: authenticatedRoute<{ book_id: string }>(async ({ request, params, library }) => regenerateBook(library, params.book_id, await request.formData())) } } });
