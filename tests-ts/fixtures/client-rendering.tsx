import { hydrate, render, renderToString, isServer } from "@solidjs/web";
import { createSignal, flush, Loading, onCleanup, type ComponentProps } from "solid-js";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, redirect } from "@tanstack/solid-router";
import { AppShell } from "../../src/shell/app-shell";
import { InstallAppButton } from "../../src/features/settings/install-app";
import { SettingsHub } from "../../src/features/settings/hub";
import type { InstallMode } from "../../src/client/pwa/install";
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
import { KindleProvider, useKindle, type KindleContextValue } from "../../src/features/kindle/context";
import { KindleTabs } from "../../src/features/kindle/tabs";
import { Link } from "../../src/shared/spa-link";
import type { KindleDeviceManager } from "../../src/client/kindle/device";
import type { TransferQueue } from "../../src/client/kindle/queue";
import { Route as securityRoute } from "../../src/routes/_app.security";
import { Route as ingestRoute } from "../../src/routes/_app.ingest";

export function loginRedirect(next: string) { return redirect({ href: `/login?next=${encodeURIComponent(next)}` }); }
function RoutePending() { return <p data-route-pending>入库页加载中</p>; }
type IngestRouteOptions = {
  validateSearch?: (search: Record<string, unknown>) => Record<string, unknown>;
  loaderDeps?: (context: { search: Record<string, unknown> }) => Record<string, unknown>;
  shouldReload?: boolean | ((context: { cause: "preload" | "enter" | "stay" }) => unknown);
};
const ingestOptions = ingestRoute.options as unknown as IngestRouteOptions;

export async function navigationWorkspace(node: HTMLElement, initialLibrary: LibraryPageData, initialIngest: Cases["ingest"], entry: string, regenerate: ComponentProps<typeof LibraryPage>["regenerate"] = async () => ({ queued: 1, failed: 0, skipped: 0 })) {
  let library = initialLibrary, ingest = initialIngest, libraryLoads = 0, ingestLoads = 0;
  const root = createRootRoute({ component: AppShell });
  const home = createRoute({ getParentRoute: () => root, path: "/", validateSearch: (search: Record<string, unknown>) => search, loaderDeps: ({ search }) => search,
    loader: () => { libraryLoads++; return library; }, component: () => { const data = home.useLoaderData(); return <LibraryPage data={data()} regenerate={regenerate} />; } });
  const upload = createRoute({ getParentRoute: () => root, path: "/ingest", validateSearch: ingestOptions.validateSearch, loaderDeps: ingestOptions.loaderDeps, shouldReload: ingestOptions.shouldReload,
    pendingComponent: RoutePending, pendingMs: 0,
    loader: ({ location }) => { ingestLoads++; const { tab, page } = jobsSearch(Object.fromEntries(new URLSearchParams(location.searchStr))); return { options: ingest.options, jobs: { ...ingest.jobs!, active_tab: tab, page } }; },
    component: () => { const data = upload.useLoaderData(); return <IngestScreen data={data()} />; } });
  const others = ["/login", "/settings", "/rules", "/security", "/tracker", "/book/$book_id", "/book/$book_id/preview"].map(path => createRoute({ getParentRoute: () => root, path, validateSearch: (search: Record<string, unknown>) => search, component: () => <p>{path}</p> }));
  const router = createRouter({ routeTree: root.addChildren([home, upload, ...others]), history: createMemoryHistory({ initialEntries: [entry] }), isServer: false, origin: "http://bindery.local" });
  await router.load();
  const dispose = render(() => <Loading><RouterProvider router={router} /></Loading>, node);
  return { router, dispose, flush, href: () => router.state.location.href, libraryLoads: () => libraryLoads, ingestLoads: () => ingestLoads,
    nextLibrary(value: LibraryPageData) { library = value; }, nextIngest(value: Cases["ingest"]) { ingest = value; } };
}

export async function securityNavigation(node: HTMLElement) {
  const root = createRootRoute({ component: () => <Outlet /> });
  securityRoute.update({ id: "/security", path: "/security", getParentRoute: () => root } as never);
  const login = createRoute({ getParentRoute: () => root, path: "/login", validateSearch: (search: Record<string, unknown>) => search, component: () => <p>登录</p> });
  const router = createRouter({ routeTree: root.addChildren([securityRoute, login]), history: createMemoryHistory({ initialEntries: ["/security"] }), isServer: false, origin: "http://localhost" });
  await router.load();
  const dispose = render(() => <Loading><RouterProvider router={router} /></Loading>, node); flush();
  return { router, dispose, flush };
}

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
  install: { mode: InstallMode | null };
  settings: ComponentProps<typeof SettingsHub>;
};

function view<K extends keyof Cases>(kind: K, data: () => Cases[K]) {
  // Kind is fixed for each mount; updates flow through the real component props.
  switch (kind) {
    case "library": return <LibraryPage data={(data as () => Cases["library"])()} passkeyPrompt={(data as () => Cases["library"])().passkey_prompt} regenerate={async () => ({ queued: 0, failed: 0, skipped: 0 })} />;
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
    case "install": return <InstallAppButton mode={(data as () => Cases["install"])().mode} onInstall={() => {}} />;
    case "settings": return <SettingsHub {...(data as () => Cases["settings"])()} />;
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
  const template = { id: "default", name: "默认规则", description: "", version: "1", raw: "{}", saved: false, error: null, book_count: 0, archived_count: 0 };
  const rules = createRoute({ getParentRoute: () => root, path: "/rules", component: () => <RulesPage data={{ rules: [template], themes: [], tab: "parsing", ruleId: "default", themeId: "default", editor: template, error: "" }} /> });
  const settings = createRoute({ getParentRoute: () => root, path: "/settings", component: () => <SettingsHub summary={{ rules: { count: 0, recently_modified: null }, themes: { count: 0, ingest_default: null }, security: { passkey_count: 0, last_used_at: null }, lexitrace: { configured: false, enabled: false } }} now={0} /> });
  const reader = createRoute({ getParentRoute: () => root, path: "/book/$book_id/preview/$section", staticData: { readerLayout: true }, component: () => <p>阅读正文</p> });
  const router = createRouter({ routeTree: root.addChildren([home, rules, settings, reader]), history: createMemoryHistory({ initialEntries: [entry] }), isServer, origin: "http://bindery.local" });
  return { router, setData(value: LibraryPageData) { next = value; } };
}

function ingestRoutes(initial: Cases["ingest"], entry: string, deferred = false) {
  let started = 0, settled = 0;
  const releases: (() => void)[] = [];
  // Include the real shell: its layout branch must preserve staged state on search navigation.
  const root = createRootRoute({ component: AppShell });
  const ingest = createRoute({
    getParentRoute: () => root, path: "/ingest", validateSearch: ingestOptions.validateSearch, loaderDeps: ingestOptions.loaderDeps, shouldReload: ingestOptions.shouldReload,
    pendingComponent: RoutePending, pendingMs: 0,
    loader: async ({ location }) => {
      const load = ++started;
      if (deferred && load > 1) await new Promise<void>(resolve => releases.push(resolve));
      const { tab, page } = jobsSearch(Object.fromEntries(new URLSearchParams(location.searchStr)));
      settled++;
      return { options: structuredClone(initial.options), jobs: { ...initial.jobs!, active_tab: tab, page } };
    },
    component: () => { const data = ingest.useLoaderData(); return <IngestScreen data={data()} />; },
  });
  const router = createRouter({ routeTree: root.addChildren([ingest]), history: createMemoryHistory({ initialEntries: [entry] }), isServer, origin: "http://bindery.local" });
  return { router, ingestLoads: () => started, settledLoads: () => settled, releaseLoad: () => releases.shift()?.() };
}
export async function routedIngestMarkup(initial: Cases["ingest"], entry: string) {
  const { router } = ingestRoutes(initial, entry); await router.load();
  return renderToString(() => <Loading><RouterProvider router={router} /></Loading>);
}
export async function routedIngest(root: HTMLElement, initial: Cases["ingest"], entry: string, hydrating = false, deferred = false) {
  const { router, ingestLoads, settledLoads, releaseLoad } = ingestRoutes(initial, entry, deferred); await router.load();
  const dispose = (hydrating ? hydrate : render)(() => <Loading><RouterProvider router={router} /></Loading>, root);
  return { href: () => router.state.location.href, historyLength: () => router.history.length, ingestLoads, settledLoads, releaseLoad, flush, dispose };
}

// Actual Router + actual components. Only RPC transport is replaced by the
// component-build plugin; invalidation must really rerun the route loader.
export async function spaNavigation(node: HTMLElement, initial: Cases["detail"], tracker: Cases["tracker"], manager: KindleDeviceManager, queue: TransferQueue) {
  let next = initial, loads = 0, context: KindleContextValue | undefined, mounts = 0, cleanups = 0;
  const root = createRootRoute({ component: () => <div data-spa-shell><Outlet /></div> });
  const detail = createRoute({ getParentRoute: () => root, path: "/book/$book_id", loader: () => { loads++; return next; }, component: () => {
    const data = detail.useLoaderData(); return <BookDetail page={data()} />;
  } });
  const tracking = createRoute({ getParentRoute: () => root, path: "/tracker", validateSearch: (search: Record<string, unknown>) => search, component: () => <TrackerPage data={tracker} /> });
  function Capture() { const k = useKindle(); context = k; mounts++; onCleanup(() => { cleanups++; }); return <><p data-queue-state>{k.items().map(item => item.state).join(",")}</p><Link href="/devices/transfer?book=a#queue">查询与锚点</Link><Link href="#license">本页锚点</Link></>; }
  const kindle = createRoute({ getParentRoute: () => root, path: "/devices", component: () => <KindleProvider manager={manager} queue={queue}><Capture /><KindleTabs /><Outlet /></KindleProvider> });
  const children = ["/", "transfer", "preview", "fonts", "connect"].map(path => createRoute({ getParentRoute: () => kindle, path, component: () => <p data-kindle-page>{path}</p> }));
  const router = createRouter({ routeTree: root.addChildren([detail, tracking, kindle.addChildren(children)]), history: createMemoryHistory({ initialEntries: [`/book/${initial.book.book_id}`] }), isServer: false, origin: "http://bindery.local" });
  await router.load();
  const dispose = render(() => <Loading><RouterProvider router={router} /></Loading>, node);
  return { dispose, flush, context: () => context, mounts: () => mounts, cleanups: () => cleanups, loads: () => loads, href: () => router.state.location.href, next(page: Cases["detail"]) { next = page; }, navigate: (href: string) => router.navigate({ href }) };
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
