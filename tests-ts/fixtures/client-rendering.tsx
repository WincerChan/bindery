import { hydrate, render, renderToString, isServer } from "@solidjs/web";
import { createSignal, flush, Loading, type ComponentProps } from "solid-js";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/solid-router";
import { AppShell } from "../../src/shell/app-shell";
import { LibraryPage } from "../../src/features/library/library-page";
import { TrackerPage } from "../../src/features/catalog/tracker";
import { RulesPage } from "../../src/features/catalog/rules";
import { RulePreview } from "../../src/features/catalog/editors";
import { JobsSection } from "../../src/features/ingest/jobs";
import { UploadPreviews } from "../../src/features/ingest/preview";
import { BookDetail } from "../../src/features/books/book-detail";
import { IngestPage } from "../../src/features/ingest/page";
import { IngestScreen } from "../../src/features/ingest/screen";
import { jobsSearch } from "../../src/features/ingest/search";
import { Editor } from "../../src/features/catalog/editors";
import { TrackerForm } from "../../src/features/catalog/tracker";
import { Reader } from "../../src/features/reader/reader";
import { Pagination } from "../../src/ui/pagination";
import type { LibraryPageData } from "../../src/server/library/queries";

export type Cases = {
  library: LibraryPageData;
  libraryActions: ComponentProps<typeof LibraryPage>;
  archive: LibraryPageData["books"];
  tracker: ComponentProps<typeof TrackerPage>["data"];
  rules: ComponentProps<typeof RulesPage>["data"];
  rulePreview: ComponentProps<typeof RulePreview>["preview"];
  jobs: ComponentProps<typeof JobsSection>["data"];
  previews: ComponentProps<typeof UploadPreviews>["previews"];
  detail: ComponentProps<typeof BookDetail>["page"];
  reader: ComponentProps<typeof Reader>["data"] & { query?: string };
  ingest: ComponentProps<typeof IngestPage>;
  editor: ComponentProps<typeof Editor>;
  trackerForm: ComponentProps<typeof TrackerForm>;
  pagination: ComponentProps<typeof Pagination>;
};

function view<K extends keyof Cases>(kind: K, data: () => Cases[K]) {
  // Kind is fixed for each mount; updates flow through the real component props.
  switch (kind) {
    case "library": return <LibraryPage data={(data as () => Cases["library"])()} regenerate={async () => ({ queued: 0, failed: 0, skipped: 0 })} />;
    case "libraryActions": return <LibraryPage {...(data as () => Cases["libraryActions"])()} />;
    case "archive": return <LibraryPage data={{ scope: "archived", books: (data as () => Cases["archive"])().map(book => ({ ...book, archived: true })), total_books: (data as () => Cases["archive"])().length, page: 1, per_page: 24, total_pages: 1, sort: "updated", q: "", read_filter: "all", has_prev: false, has_next: false, prev_page: 1, next_page: 1, return_to: "/?scope=archived" }} restore={async () => {}} refresh={async () => {}} regenerate={async () => ({ queued: 0, failed: 0, skipped: 0 })} />;
    case "tracker": return <TrackerPage data={(data as () => Cases["tracker"])()} />;
    case "rules": return <RulesPage data={(data as () => Cases["rules"])()} />;
    case "rulePreview": return <RulePreview preview={(data as () => Cases["rulePreview"])()} />;
    case "jobs": return <JobsSection data={(data as () => Cases["jobs"])()} />;
    case "previews": return <UploadPreviews previews={(data as () => Cases["previews"])()} />;
    case "detail": return <BookDetail page={(data as () => Cases["detail"])()} />;
    case "reader": return <Reader data={(data as () => Cases["reader"])()} query={new URLSearchParams((data as () => Cases["reader"])().query ?? "")} />;
    case "ingest": return <IngestPage {...(data as () => Cases["ingest"])()} />;
    case "editor": return <Editor {...(data as () => Cases["editor"])()} />;
    case "trackerForm": return <TrackerForm {...(data as () => Cases["trackerForm"])()} />;
    case "pagination": return <Pagination {...(data as () => Cases["pagination"])()} />;
  }
}

export function markup<K extends keyof Cases>(kind: K, data: Cases[K]) {
  return renderToString(() => <Loading>{view(kind, () => data)}</Loading>);
}

export function mount<K extends keyof Cases>(root: HTMLElement, kind: K, initial: Cases[K], hydrating = false) {
  const [state, setState] = createSignal({ value: initial });
  const dispose = (hydrating ? hydrate : render)(() => <Loading>{view(kind, () => state().value)}</Loading>, root);
  return { update(next: Cases[K]) { setState({ value: next }); flush(); }, flush, dispose };
}

function routes(initial: LibraryPageData, entry: string) {
  let next = initial;
  const root = createRootRoute({ component: AppShell });
  const home = createRoute({
    getParentRoute: () => root, path: "/",
    validateSearch: (search: Record<string, unknown>) => search,
    loaderDeps: ({ search }) => search, loader: async () => next,
    component: () => {
      const data = home.useLoaderData();
      return <LibraryPage data={data()} onSearch={search => router.navigate({ to: "/", search: { ...search } })} regenerate={async () => ({ queued: 0, failed: 0, skipped: 0 })} />;
    },
  });
  const template = { id: "default", name: "默认规则", description: "", version: "1", raw: "{}", saved: false, error: null };
  const rules = createRoute({ getParentRoute: () => root, path: "/rules", component: () => <RulesPage data={{ rules: [template], themes: [], tab: "parsing", ruleId: "default", themeId: "default", editor: template, error: "" }} /> });
  const router = createRouter({ routeTree: root.addChildren([home, rules]), history: createMemoryHistory({ initialEntries: [entry] }), isServer, origin: "http://bindery.local" });
  return { router, setData(value: LibraryPageData) { next = value; } };
}

function ingestRoutes(initial: Cases["ingest"], entry: string) {
  const root = createRootRoute();
  const ingest = createRoute({
    getParentRoute: () => root, path: "/ingest", validateSearch: (search: Record<string, unknown>) => search,
    loaderDeps: ({ search }) => search, loader: ({ location }) => {
      const { tab, page } = jobsSearch(Object.fromEntries(new URLSearchParams(location.searchStr)));
      return { options: structuredClone(initial.options), jobs: { ...initial.jobs!, active_tab: tab, page } };
    },
    component: () => { const data = ingest.useLoaderData(); return <IngestScreen data={data()} />; },
  });
  return createRouter({ routeTree: root.addChildren([ingest]), history: createMemoryHistory({ initialEntries: [entry] }), isServer, origin: "http://bindery.local" });
}
export async function routedIngestMarkup(initial: Cases["ingest"], entry: string) {
  const router = ingestRoutes(initial, entry); await router.load();
  return renderToString(() => <Loading><RouterProvider router={router} /></Loading>);
}
export async function routedIngest(root: HTMLElement, initial: Cases["ingest"], entry: string, hydrating = false) {
  const router = ingestRoutes(initial, entry); await router.load();
  const dispose = (hydrating ? hydrate : render)(() => <Loading><RouterProvider router={router} /></Loading>, root);
  return { href: () => router.state.location.href, historyLength: () => router.history.length, flush, dispose };
}

export async function routedMarkup(initial: LibraryPageData, entry: string) {
  const { router } = routes(initial, entry);
  await router.load();
  return renderToString(() => <Loading><RouterProvider router={router} /></Loading>);
}

export async function routedLibrary(root: HTMLElement, initial: LibraryPageData, entry: string, hydrating = false) {
  const { router, setData } = routes(initial, entry);
  await router.load();
  const dispose = (hydrating ? hydrate : render)(() => <Loading><RouterProvider router={router} /></Loading>, root);
  return {
    async update(value: LibraryPageData) {
      setData(value);
      await router.navigate({ to: "/", search: { q: value.q, read_filter: value.read_filter, page: value.page } });
      flush();
    },
    flush, dispose,
  };
}
