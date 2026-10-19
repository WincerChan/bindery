import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";

export const Route = createFileRoute("/library")({ server: { handlers: {
  GET: authenticatedRoute(async ({ request, library }) => (await import("../server/library/partial")).libraryPartial(request, library)),
} } });
