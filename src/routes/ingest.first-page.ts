import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";
import { firstPageResponse } from "../server/ingest/first-page";

export const Route = createFileRoute("/ingest/first-page")({ server: { handlers: {
  POST: authenticatedRoute(({ request, library }) => firstPageResponse(request, library)),
} } });
