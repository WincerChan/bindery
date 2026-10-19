import { fileURLToPath } from "node:url";
import { staticMiddleware } from "srvx/static";

// Kept separate from listen() so the actual production handler can be tested without sockets.
export async function createProductionHandler() {
  const { default: app } = await import("../dist/server/server.js");
  const assets = staticMiddleware({
    dir: fileURLToPath(new URL("../dist/client/", import.meta.url)),
    dotfiles: false,
  });
  let closing = false;
  return Object.assign(
    (request) => closing
      ? new Response("Service is shutting down", { status: 503, headers: { "Cache-Control": "no-store", Connection: "close" } })
      : assets(request, () => app.fetch(request)),
    { shutdown(options) { closing = true; return app.shutdownRuntime(options); } },
  );
}
