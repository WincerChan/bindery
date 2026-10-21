import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/solid-router";
import { Route as jobs } from "../../src/routes/_app.jobs";
import { Route as archive } from "../../src/routes/_app.archive";
import { Route as legacyKindle } from "../../src/routes/_app.kindle";
import { Route as legacyKindleIndex } from "../../src/routes/_app.kindle.index";
import { Route as legacyKindlePreview } from "../../src/routes/_app.kindle.preview";
import { legacyDeviceTarget } from "../../src/features/devices/redirects";

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

/** Exercises the real legacy route beforeLoad functions on client navigation. */
export async function navigateDevice(entry: string) {
  const root = createRootRoute();
  const legacy = createRoute({ getParentRoute: () => root, path: "/kindle", beforeLoad: context => legacyKindle.options.beforeLoad!({ ...context } as never) });
  const legacyIndex = createRoute({ getParentRoute: () => root, path: "/kindle/", beforeLoad: context => legacyKindleIndex.options.beforeLoad!({ ...context } as never) });
  const legacyPreview = createRoute({ getParentRoute: () => root, path: "/kindle/preview", validateSearch: (search: Record<string, unknown>) => search, beforeLoad: context => legacyKindlePreview.options.beforeLoad!({ ...context } as never) });
  const target = createRoute({ getParentRoute: () => root, path: "/devices", component: () => null });
  const targetIndex = createRoute({ getParentRoute: () => root, path: "/devices/", component: () => null });
  const targetPreview = createRoute({ getParentRoute: () => root, path: "/devices/preview", validateSearch: (search: Record<string, unknown>) => search, component: () => null });
  void legacyKindle;
  const router = createRouter({ routeTree: root.addChildren([legacy, legacyIndex, legacyPreview, target, targetIndex, targetPreview]), history: createMemoryHistory({ initialEntries: ["/"] }), isServer: false, origin: "http://bindery.local" });
  await router.load(); await router.navigate({ href: entry });
  return router.state.location.href;
}

export { legacyDeviceTarget };
