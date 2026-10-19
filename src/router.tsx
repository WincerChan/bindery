import { NotFoundPage } from "./shared/not-found-page";
import { createRouter } from "@tanstack/solid-router";
import { routeTree } from "./routeTree.gen";
export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true, defaultNotFoundComponent: NotFoundPage });
}
declare module "@tanstack/solid-router" {
  interface StaticDataRouteOption { readerLayout?: boolean }
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
