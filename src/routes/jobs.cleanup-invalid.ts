import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";
import { cleanupInvalid, formText } from "../server/ingest/actions";
export const Route = createFileRoute("/jobs/cleanup-invalid")({ server: { handlers: { POST: authenticatedRoute(async ({ request, library }) => cleanupInvalid(library, formText(await request.formData(), "tab", "all"))) } } });
