import { LibrarySkeleton } from "../ui/skeleton";
import { createFileRoute, useRouter, useRouterState } from "@tanstack/solid-router";
import { LibraryPage } from "../features/library/library-page";
import { loadLibrary, regenerateSelection } from "../features/library/functions";
import { libraryQueryInput, libraryReturnTo, type LibrarySearch } from "../features/library/search";
import "../features/library/library.css";
export const Route = createFileRoute("/_app/")({
  pendingComponent: LibrarySkeleton,
  server: { handlers: { GET: async ({ request, params, next }) => {
    if (!libraryQueryInput(Object.fromEntries(new URL(request.url).searchParams)).invalid) return next();
    const { authenticatedRoute, HttpError } = await import("../server/http");
    return authenticatedRoute(() => { throw new HttpError(422, "分页参数必须为整数"); })({ request, params });
  } } },
  validateSearch: (search: Record<string, unknown>) => search,
  // Search, filters, sorting and paging stay on the same match: the router reloads it in the background,
  // so the current results stay up instead of the route skeleton. Entering from another page still shows it.
  loader: ({ location }) => loadLibrary({ data: { ...(location.search as Record<string, unknown>) } }),
  // Without loader deps a search change keeps the match ("stay"), which the router does not reload by default.
  shouldReload: ({ cause }) => cause === "stay",
  head: () => ({ meta: [{ title: "Bindery · 书库" }] }),
  component: Home,
});
function Home() {
  const data = Route.useLoaderData(), router = useRouter(), loading = useRouterState({ select: state => state.isLoading });
  // The same URL (e.g. only the remembered page size changed) reloads in place.
  const search = (value: LibrarySearch) => { const href = libraryReturnTo({ ...value }); return href === router.state.location.href ? router.invalidate() : router.navigate({ href }); };
  return <LibraryPage data={data()} loading={loading()} passkeyPrompt={data().passkey_prompt} onSearch={search} regenerate={ids => regenerateSelection({ data: ids })} />;
}
