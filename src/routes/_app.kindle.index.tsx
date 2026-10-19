import { createFileRoute } from "@tanstack/solid-router";
import { loadLibrary } from "../features/library/functions";
import { loadKindleLibrary } from "../features/kindle/devices/library";
import { KindleBooksPage } from "../features/kindle/devices/books";
export const Route = createFileRoute("/_app/kindle/")({
  loader: () => loadKindleLibrary(page => loadLibrary({ data: { page, per_page: 96 } })),
  component: Books,
});
function Books() { const books = Route.useLoaderData(); return <KindleBooksPage books={books()} />; }
