import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";

const post = authenticatedRoute<{ book_id: string }>(async (context) =>
  (await import("../server/books/responses")).deleteResponse(context),
);
export const Route = createFileRoute("/book/$book_id/delete")({
  server: { handlers: { POST: post } },
});
