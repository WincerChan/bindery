import { createFileRoute } from "@tanstack/solid-router";
import { legacyDeviceTarget } from "../features/devices/redirects";
const serve = ({ request }: { request: Request }) => {
  const url = new URL(request.url);
  return new Response(null, { status: 302, headers: { Location: legacyDeviceTarget(url.pathname) + url.search } });
};
export const Route = createFileRoute("/kindle/content/$book_id/$mode/epub/$")({ server: { handlers: { GET: serve, HEAD: serve } } });
