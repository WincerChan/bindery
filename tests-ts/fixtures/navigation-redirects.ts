import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/solid-router";
import { Route as jobs } from "../../src/routes/_app.jobs";
import { Route as archive } from "../../src/routes/_app.archive";

export async function navigate(entry: string) {
  const root = createRootRoute();
  const legacyJobs = createRoute({ getParentRoute: () => root, path: "/jobs", beforeLoad: context => jobs.options.beforeLoad!({ ...context } as never) });
  const legacyArchive = createRoute({ getParentRoute: () => root, path: "/archive", beforeLoad: context => archive.options.beforeLoad!({ ...context } as never) });
  const home = createRoute({ getParentRoute: () => root, path: "/", validateSearch: (search: Record<string, unknown>) => search });
  const ingest = createRoute({ getParentRoute: () => root, path: "/ingest", validateSearch: (search: Record<string, unknown>) => search });
  const router = createRouter({ routeTree: root.addChildren([home, ingest, legacyJobs, legacyArchive]), history: createMemoryHistory({ initialEntries: ["/"] }), isServer: false, origin: "http://bindery.local" });
  await router.load(); await router.navigate({ href: entry });
  return router.state.location.href;
}
