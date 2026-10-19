import { createFileRoute } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { createSignal, createEffect, onCleanup, onSettled } from "solid-js";
import { authenticatedRoute, HttpError } from "../server/http";
import { authenticated } from "../server/functions";
import { JobsSection } from "../features/ingest/jobs";
import type { JobsPayload } from "../server/ingest/queries";
import "../features/ingest/ingest.css";
const loadJobs = createServerFn({ method: "GET" }).middleware([authenticated]).inputValidator((data: { tab: string; page: number }) => data).handler(async ({ context, data }) => (await import("../server/ingest/queries")).jobsPayload(context.library, data.tab, data.page));
export const Route = createFileRoute("/_app/jobs")({
  validateSearch: (search: Record<string, unknown>) => ({ ...search, ...(typeof search.tab === "string" ? { tab: search.tab } : {}), ...(search.page !== undefined ? { page: search.page } : {}) }),
  loaderDeps: ({ search }) => ({ tab: search.tab || "running", page: Number(search.page) || 1 }),
  loader: ({ deps }) => loadJobs({ data: deps }),
  server: { handlers: { GET: async context => {
    const raw = new URL(context.request.url).searchParams.get("page");
    if (raw !== null && !/^[+-]?\d+(?:\.0+)?$/.test(raw.trim())) return authenticatedRoute(async () => { throw new HttpError(422, "Input should be a valid integer"); })(context);
    return context.next();
  } } },
  head: () => ({ meta: [{ title: "任务 · Bindery" }] }), component: JobsPage,
});
function JobsPage() {
  const initial = Route.useLoaderData(), [data, setData] = createSignal<JobsPayload>(initial());
  let controller: AbortController | undefined, timer: ReturnType<typeof setInterval> | undefined;
  createEffect(() => initial(), value => { controller?.abort(); setData(value); });
  onSettled(() => {
    if (typeof window === "undefined" || timer) return;
    timer = setInterval(async () => {
      if (document.hidden || controller) return;
      const current = new AbortController(); controller = current;
      const tab = data().active_tab, page = data().page;
      try {
        const response = await fetch(`/jobs/partial?tab=${tab}&page=${page}`, { headers: { Accept: "application/json" }, signal: current.signal });
        if (response.ok && !current.signal.aborted && tab === data().active_tab && page === data().page) setData(await response.json());
      } catch (error) { if (!current.signal.aborted) console.error(error); }
      finally { if (controller === current) controller = undefined; }
    }, 5000);
  });
  onCleanup(() => { if (timer) clearInterval(timer); controller?.abort(); });
  return <div class="ingest-jobs-page"><div class="page-head"><h1>任务</h1><p class="muted">查看转换与写回的进度。</p></div><JobsSection data={data()} /></div>;
}
