import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";

const post = authenticatedRoute<{ book_id: string }>(async (context) =>
  (await import("../server/books/responses")).uploadCoverResponse(context),
);
export const Route = createFileRoute("/book/$book_id/cover/upload")({
  server: { handlers: { POST: post } },
});
