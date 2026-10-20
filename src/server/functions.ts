import { createMiddleware } from "@tanstack/solid-start";
import { isRedirect, redirect } from "@tanstack/solid-router";
import { loginTarget } from "../shared/session-navigation";

// Keep this module client-safe: all Node imports belong inside .server().
// Keep createServerFn() itself at each call site so Start can compile its RPC.
export const authenticated = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const { getRequest, setResponseStatus } = await import("@tanstack/solid-start/server");
  const { requireAuth, httpError } = await import("./http");
  try {
    const library = requireAuth(getRequest());
    return await next({ context: { library } });
  } catch (error) {
    if (isRedirect(error)) throw error;
    if (error instanceof Response) {
      if (error.headers.get("Location")?.startsWith("/login?")) {
        const request = getRequest(), url = new URL(request.url);
        let current = "/";
        try {
          const referer = new URL(request.headers.get("Referer") || "");
          if (referer.origin === url.origin) current = referer.pathname + referer.search;
        } catch { /* Missing or invalid Referer: return to the library. */ }
        throw redirect({ href: loginTarget(current) });
      }
      throw error;
    }
    const mapped = httpError(error);
    if (mapped.status === 500) console.error(error);
    setResponseStatus(mapped.status);
    throw mapped;
  }
});
