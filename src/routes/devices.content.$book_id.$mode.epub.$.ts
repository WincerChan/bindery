import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";
import { kindlePreviewResource } from "../server/kindle/preview";

const serve = authenticatedRoute<{ book_id: string; mode: string; _splat?: string }>(({ request, params, library }) => kindlePreviewResource(request, params.book_id, params.mode, params._splat || "", library));
export const Route = createFileRoute("/devices/content/$book_id/$mode/epub/$")({ server: { handlers: { GET: serve, HEAD: serve } } });
