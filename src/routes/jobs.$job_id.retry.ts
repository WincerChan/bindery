import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";
import { regenerateBook } from "../server/ingest/actions";
export const Route = createFileRoute("/jobs/$job_id/retry")({ server: { handlers: { POST: authenticatedRoute<{ job_id: string }>(async ({ request, params, library }) => regenerateBook(library, "", await request.formData(), params.job_id)) } } });
