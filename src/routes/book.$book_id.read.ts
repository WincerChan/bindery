import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";

const post = authenticatedRoute<{ book_id: string }>(async (context) =>
  (await import("../server/books/responses")).readResponse(context),
);
export const Route = createFileRoute("/book/$book_id/read")({
  server: { handlers: { POST: post } },
});
