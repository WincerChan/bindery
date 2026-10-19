import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";

const post = authenticatedRoute<{ book_id: string }>(async (context) =>
  (await import("../server/books/responses")).restoreResponse(context),
);
export const Route = createFileRoute("/book/$book_id/restore")({
  server: { handlers: { POST: post } },
});
