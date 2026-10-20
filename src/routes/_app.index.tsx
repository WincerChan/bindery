import { createFileRoute, useRouter } from "@tanstack/solid-router";
import { LibraryPage } from "../features/library/library-page";
import { loadLibrary, regenerateSelection } from "../features/library/functions";
import { libraryQueryInput } from "../features/library/search";
import "../features/library/library.css";
export const Route = createFileRoute("/_app/")({
  server: { handlers: { GET: async ({ request, params, next }) => {
    if (!libraryQueryInput(Object.fromEntries(new URL(request.url).searchParams)).invalid) return next();
    const { authenticatedRoute, HttpError } = await import("../server/http");
    return authenticatedRoute(() => { throw new HttpError(422, "分页参数必须为整数"); })({ request, params });
  } } },
  validateSearch: (search: Record<string, unknown>) => search,
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => loadLibrary({ data: { ...deps } }),
  head: () => ({ meta: [{ title: "Bindery · 书库" }] }),
  component: Home,
});
function Home() {
  const data = Route.useLoaderData(), router = useRouter();
  return <LibraryPage data={data()} onSearch={search => router.navigate({ to: "/", search: { ...search } })} regenerate={ids => regenerateSelection({ data: ids })} />;
}
