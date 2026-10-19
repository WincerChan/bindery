import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";
import { deletePost } from "../server/library/handlers";

export const Route = createFileRoute("/archive/delete-bulk")({ server: { handlers: {
  POST: authenticatedRoute(deletePost),
} } });
