import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";
export const Route = createFileRoute("/themes/$theme_id/delete")({
  server: { handlers: { POST: authenticatedRoute<{ theme_id: string }>(async context => (await import("../server/catalog/http")).deleteTemplateHandler("themes")(context)) } },
});

