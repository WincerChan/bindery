import { createFileRoute, useRouter } from "@tanstack/solid-router";
import { ArchivePage } from "../features/library/archive-page";
import { loadArchive, restoreSelection } from "../features/library/functions";
import "../features/library/library.css";

export const Route = createFileRoute("/_app/archive")({
  loader: () => loadArchive(), head: () => ({ meta: [{ title: "归档 · Bindery" }] }), component: Archive,
});
function Archive() {
  const data = Route.useLoaderData(), router = useRouter();
  return <ArchivePage books={data()} restore={ids => restoreSelection({ data: ids })} refresh={() => router.invalidate()} />;
}
