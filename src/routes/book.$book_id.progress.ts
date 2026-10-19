import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";
import { saveProgress } from "../server/reader/service";
const save = authenticatedRoute<{ book_id: string }>(({ request, params, library }) => saveProgress(request, params.book_id, library));
export const Route = createFileRoute("/book/$book_id/progress")({ server: { handlers: { POST: save } } });
