import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";
import { searchBook } from "../server/reader/search";
const search = authenticatedRoute<{ book_id: string }>(({ request, params, library }) => searchBook(request, params.book_id, library));
export const Route = createFileRoute("/book/$book_id/search")({ server: { handlers: { GET: search } } });
