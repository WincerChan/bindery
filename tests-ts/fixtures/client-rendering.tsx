import { hydrate, render, renderToString, isServer } from "@solidjs/web";
import { createSignal, flush, Loading, type ComponentProps } from "solid-js";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/solid-router";
import { AppShell } from "../../src/shell/app-shell";
import { LibraryPage } from "../../src/features/library/library-page";
import { ArchivePage } from "../../src/features/library/archive-page";
import { TrackerPage } from "../../src/features/catalog/tracker";
import { RulesPage } from "../../src/features/catalog/rules";
import { RulePreview } from "../../src/features/catalog/editors";
import { JobsSection } from "../../src/features/ingest/jobs";
import { UploadPreviews } from "../../src/features/ingest/preview";
import { BookDetail } from "../../src/features/books/book-detail";
import { Reader } from "../../src/features/reader/reader";
import { Pagination } from "../../src/ui/pagination";
import type { LibraryPageData } from "../../src/server/library/queries";

export type Cases = {
  library: LibraryPageData;
  archive: ComponentProps<typeof ArchivePage>["books"];
  tracker: ComponentProps<typeof TrackerPage>["data"];
  rules: ComponentProps<typeof RulesPage>["data"];
  rulePreview: ComponentProps<typeof RulePreview>["preview"];
  jobs: ComponentProps<typeof JobsSection>["data"];
  previews: ComponentProps<typeof UploadPreviews>["previews"];
  detail: ComponentProps<typeof BookDetail>["page"];
  reader: ComponentProps<typeof Reader>["data"];
  pagination: ComponentProps<typeof Pagination>;
};

function view<K extends keyof Cases>(kind: K, data: () => Cases[K]) {
  // Kind is fixed for each mount; updates flow through the real component props.
  switch (kind) {
    case "library": return <LibraryPage data={(data as () => Cases["library"])()} regenerate={async () => ({ queued: 0, failed: 0, skipped: 0 })} />;
    case "archive": return <ArchivePage books={(data as () => Cases["archive"])()} restore={async () => {}} refresh={async () => {}} />;
    case "tracker": return <TrackerPage data={(data as () => Cases["tracker"])()} />;
    case "rules": return <RulesPage data={(data as () => Cases["rules"])()} />;
    case "rulePreview": return <RulePreview preview={(data as () => Cases["rulePreview"])()} />;
    case "jobs": return <JobsSection data={(data as () => Cases["jobs"])()} />;
    case "previews": return <UploadPreviews previews={(data as () => Cases["previews"])()} />;
    case "detail": return <BookDetail page={(data as () => Cases["detail"])()} />;
    case "reader": return <Reader data={(data as () => Cases["reader"])()} query={new URLSearchParams()} />;
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
