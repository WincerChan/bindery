import { DeviceBodySkeleton } from "../ui/skeleton";
import { createFileRoute } from "@tanstack/solid-router";
import { loadLibrary } from "../features/library/functions";
import { loadDeviceLibrary } from "../features/devices/library";
import { DeviceBooksPage } from "../features/devices/books";
export const Route = createFileRoute("/_app/devices/")({
  pendingComponent: DeviceBodySkeleton,
  loader: () => loadDeviceLibrary(page => loadLibrary({ data: { page, per_page: 96 } })),
  component: Books,
});
function Books() { const books = Route.useLoaderData(); return <DeviceBooksPage books={books()} />; }
