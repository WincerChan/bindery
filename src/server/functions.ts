import { createMiddleware } from "@tanstack/solid-start";

// Keep this module client-safe: all Node imports belong inside .server().
// Keep createServerFn() itself at each call site so Start can compile its RPC.
export const authenticated = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const { getRequest, setResponseStatus } = await import("@tanstack/solid-start/server");
  const { requireAuth, httpError } = await import("./http");
  try {
    const library = requireAuth(getRequest());
    return await next({ context: { library } });
  } catch (error) {
    if (error instanceof Response) throw error;
    const mapped = httpError(error);
    if (mapped.status === 500) console.error(error);
    setResponseStatus(mapped.status);
    throw mapped;
  }
});
