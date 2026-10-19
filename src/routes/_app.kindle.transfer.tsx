import { createFileRoute } from "@tanstack/solid-router";
import { loadLibrary } from "../features/library/functions";
import { listKindleProfiles } from "../server/kindle/functions";
import { loadKindleLibrary } from "../features/kindle/devices/library";
import { KindleTransferPage } from "../features/kindle/devices/transfer";
export const Route = createFileRoute("/_app/kindle/transfer")({
  loader: () => loadKindleLibrary(page => loadLibrary({ data: { page, per_page: 96 } })),
  component: Transfer,
});
function Transfer() { const books = Route.useLoaderData(); return <KindleTransferPage books={books()} loadProfiles={deviceId => listKindleProfiles({ data: deviceId })} />; }
