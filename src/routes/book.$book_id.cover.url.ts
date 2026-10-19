import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";

const post = authenticatedRoute<{ book_id: string }>(async (context) =>
  (await import("../server/books/responses")).urlCoverResponse(context),
);
export const Route = createFileRoute("/book/$book_id/cover/url")({
  server: { handlers: { POST: post } },
});
