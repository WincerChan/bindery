import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";
import { regenerateBulk } from "../server/ingest/actions";
export const Route = createFileRoute("/books/regenerate")({ server: { handlers: { POST: authenticatedRoute(async ({ request, library }) => regenerateBulk(library, await request.formData())) } } });
