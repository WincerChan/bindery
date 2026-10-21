import { ReaderSkeleton } from "../ui/skeleton";
import { loadOrNotFound } from "../shared/not-found";
import { NotFoundPage } from "../shared/not-found-page";
import { createFileRoute } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../server/functions";
import { authenticatedRoute, HttpError } from "../server/http";
import { Reader } from "../features/reader/reader";
import { Link } from "../shared/spa-link";
import "../features/reader/reader.css";

interface ReaderSearch { return_to?: string; resume?: number; page?: string; nav?: string; find?: string | number | boolean }
const getReader = createServerFn({ method: "GET" }).middleware([authenticated])
  .validator((input: { bookId: string; section: string; returnTo: string }) => ({ bookId: typeof input?.bookId === "string" ? input.bookId : "", section: typeof input?.section === "string" ? input.section : "", returnTo: typeof input?.returnTo === "string" ? input.returnTo : "/" }))
  .handler(async ({ data, context }) => (await import("../server/reader/service")).loadReader(data.bookId, data.section, data.returnTo, context.library));
export const Route = createFileRoute("/_app/book/$book_id_/preview_/$section")({
  pendingComponent: ReaderSkeleton,
  server: { handlers: { GET: async ({ request, params, next }) => {
    const { bigIntegerParameter } = await import("../server/reader/parameters");
    if (bigIntegerParameter(params.section) !== null) return next();
    return authenticatedRoute<{ book_id: string; section: string }>(() => { throw new HttpError(422, "请求参数无效"); })({ request, params });
  } } },
  validateSearch: (search: Record<string, unknown>): ReaderSearch => ({
    ...(typeof search.return_to === "string" ? { return_to: search.return_to } : {}),
    ...(search.resume === 1 || search.resume === 0 ? { resume: search.resume } : {}),
    ...(search.page === "last" ? { page: "last" } : {}),
    ...(search.nav === "prev" || search.nav === "next" ? { nav: search.nav } : {}),
    ...(typeof search.find === "string" ? { find: search.find.slice(0, 200) } : typeof search.find === "number" || typeof search.find === "boolean" ? { find: search.find } : {}),
  }),
  loaderDeps: ({ search }) => ({ returnTo: search.return_to || "/" }),
  staticData: { readerLayout: true },
  loader: ({ params, deps }) => loadOrNotFound(() => getReader({ data: { bookId: params.book_id, section: params.section, returnTo: deps.returnTo } })),
  head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.book.title || "阅读"} · Bindery` }] }),
  headers: () => ({ "Cache-Control": "no-store, max-age=0", "CDN-Cache-Control": "no-store", Pragma: "no-cache", Expires: "0" }),
  component: ReaderPage,
  notFoundComponent: NotFoundPage,
  errorComponent: () => <div role="alert"><h1>阅读器加载失败，请稍后重试</h1><Link href="/">返回书库</Link></div>,
});
function ReaderPage() {
  const data = Route.useLoaderData(), search = Route.useSearch();
  return <Reader data={data()} query={new URLSearchParams(Object.entries(search()).map(([name, value]) => [name, String(value)]))} />;
}
