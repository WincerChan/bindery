import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";
export const Route = createFileRoute("/rules/$rule_id/delete")({
  server: { handlers: { POST: authenticatedRoute<{ rule_id: string }>(async context => (await import("../server/catalog/http")).deleteTemplateHandler("rules")(context)) } },
});

