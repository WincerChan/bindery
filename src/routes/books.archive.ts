import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";
import { archivePost } from "../server/library/handlers";

export const Route = createFileRoute("/books/archive")({ server: { handlers: {
  POST: authenticatedRoute(archivePost),
} } });
