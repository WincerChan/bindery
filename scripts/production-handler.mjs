import { fileURLToPath } from "node:url";
import { staticMiddleware } from "srvx/static";

// Kept separate from listen() so the actual production handler can be tested without sockets.
export async function createProductionHandler() {
  const { default: app } = await import("../dist/server/server.js");
  const assets = staticMiddleware({
    dir: fileURLToPath(new URL("../dist/client/", import.meta.url)),
    dotfiles: false,
  });
  return (request) => assets(request, () => app.fetch(request));
}
