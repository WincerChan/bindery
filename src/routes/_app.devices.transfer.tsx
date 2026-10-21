import { createFileRoute } from "@tanstack/solid-router";
import { loadLibrary } from "../features/library/functions";
import { listKindleProfiles } from "../server/kindle/functions";
import { loadDeviceLibrary } from "../features/devices/library";
import { DeviceTransferPage } from "../features/devices/transfer";
export const Route = createFileRoute("/_app/devices/transfer")({
  loader: () => loadDeviceLibrary(page => loadLibrary({ data: { page, per_page: 96 } })),
  component: Transfer,
});
function Transfer() { const books = Route.useLoaderData(); return <DeviceTransferPage books={books()} loadProfiles={deviceId => listKindleProfiles({ data: deviceId })} />; }
