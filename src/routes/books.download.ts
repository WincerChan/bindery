import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";
import { downloadPost } from "../server/library/handlers";

export const Route = createFileRoute("/books/download")({ server: { handlers: {
  POST: authenticatedRoute(downloadPost),
} } });
