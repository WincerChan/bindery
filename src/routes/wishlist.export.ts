import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";
export const Route = createFileRoute("/wishlist/export")({
  server: { handlers: { GET: authenticatedRoute(async context => (await import("../server/catalog/http")).exportHandler(context)) } },
});

