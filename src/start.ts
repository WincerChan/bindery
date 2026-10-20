import { createStart } from "@tanstack/solid-start";
import { authenticated } from "./server/functions";

// All server functions are private by default, including ones without local
// middleware. There are no anonymous RPC exemptions: login uses /login/data,
// /login and /login/passkey/* HTTP endpoints, not createServerFn().
export const startInstance = createStart(() => ({
  functionMiddleware: [authenticated],
}));
