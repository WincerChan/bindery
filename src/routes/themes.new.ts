import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";
export const Route = createFileRoute("/themes/new")({
  server: { handlers: { POST: authenticatedRoute(async context => (await import("../server/catalog/http")).createTemplateHandler("themes")(context)) } },
});

