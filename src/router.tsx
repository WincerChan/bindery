import { NotFoundPage } from "./shared/not-found-page";
import { PageSkeleton } from "./ui/skeleton";
import { createRouter } from "@tanstack/solid-router";
import { routeTree } from "./routeTree.gen";
export function getRouter() {
  // Show a skeleton only when loading is noticeable, and keep it long enough not to flash.
  return createRouter({ routeTree, scrollRestoration: true, defaultNotFoundComponent: NotFoundPage, defaultPendingComponent: PageSkeleton, defaultPendingMs: 200, defaultPendingMinMs: 300 });
}
declare module "@tanstack/solid-router" {
  interface StaticDataRouteOption { readerLayout?: boolean }
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
