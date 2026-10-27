import { TableSkeleton } from "../ui/skeleton";
import { createFileRoute } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { authenticatedRoute } from "../server/http";
import { TrackerPage } from "../features/catalog/tracker";
import "../features/catalog/tracker.css";

// Global function middleware in src/start.ts authenticates and supplies library.
const loadTracker = createServerFn({ method: "GET" })
  .validator((input: Record<string, string>) => input)
  .handler(async ({ context, data }) => (await import("../server/catalog/tracker")).trackerPage(context.library, data));
export const Route = createFileRoute("/_app/tracker")({
  pendingComponent: TableSkeleton,
  validateSearch: (search: Record<string, unknown>) => Object.fromEntries(Object.entries(search).map(([key, value]) => [key, String(value ?? "")])),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => loadTracker({ data: deps }),
  server: { handlers: { POST: authenticatedRoute(async context => (await import("../server/catalog/http")).writeTrackerHandler(context)) } },
  head: () => ({ meta: [{ title: "阅读追踪 · Bindery" }] }),
  component: Page,
});
function Page() { const data = Route.useLoaderData(); return <TrackerPage data={data()} />; }

