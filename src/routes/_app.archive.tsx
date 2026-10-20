import { createFileRoute, redirect } from "@tanstack/solid-router";
import { authenticatedRoute } from "../server/http";

export const Route = createFileRoute("/_app/archive")({
  beforeLoad: () => { throw redirect({ href: "/?scope=archived", replace: true }); },
  server: { handlers: { GET: authenticatedRoute(() => new Response(null, { status: 303, headers: { Location: "/?scope=archived" } })) } },
});
