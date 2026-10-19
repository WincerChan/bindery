import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";
export const Route = createFileRoute("/wishlist/$wish_id/delete")({
  server: { handlers: { POST: authenticatedRoute<{ wish_id: string }>(async context => (await import("../server/catalog/http")).deleteTrackerHandler(context)) } },
});

