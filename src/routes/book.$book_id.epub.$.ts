import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";
import { epubResource } from "../server/reader/resources";
const serve = authenticatedRoute<{ book_id: string; _splat?: string }>(({ request, params, library }) => epubResource(request, params.book_id, params._splat || "", library));
export const Route = createFileRoute("/book/$book_id/epub/$")({ server: { handlers: { GET: serve, HEAD: serve } } });
