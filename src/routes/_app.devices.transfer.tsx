import { DeviceBodySkeleton } from "../ui/skeleton";
import { createFileRoute } from "@tanstack/solid-router";
import { loadLibrary } from "../features/library/functions";
import { listTypesetProfiles } from "../server/typeset/functions";
import { loadDeviceLibrary } from "../features/devices/library";
import { DeviceTransferPage } from "../features/devices/transfer";
import { transferSelection } from "../features/library/search";
export const Route = createFileRoute("/_app/devices/transfer")({
  pendingComponent: DeviceBodySkeleton,
  validateSearch: (search: Record<string, unknown>): { books?: string } => typeof search.books === "string" ? { books: search.books } : {},
  loader: () => loadDeviceLibrary(page => loadLibrary({ data: { page, per_page: 96 } })),
  component: Transfer,
});
function Transfer() {
  const books = Route.useLoaderData(), search = Route.useSearch();
  return <DeviceTransferPage books={books()} preselected={transferSelection(search().books)} loadProfiles={() => listTypesetProfiles()} />;
}
