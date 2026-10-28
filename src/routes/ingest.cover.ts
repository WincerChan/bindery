import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";
import { stagedCoverResponse } from "../server/ingest/cover";

export const Route = createFileRoute("/ingest/cover")({ server: { handlers: {
  GET: authenticatedRoute(({ request, library }) => stagedCoverResponse(request, library)),
} } });
