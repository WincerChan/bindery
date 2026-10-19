import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";
export const Route = createFileRoute("/wishlist/$wish_id/update")({
  server: { handlers: { POST: authenticatedRoute<{ wish_id: string }>(async context => (await import("../server/catalog/http")).writeTrackerHandler(context)) } },
});

