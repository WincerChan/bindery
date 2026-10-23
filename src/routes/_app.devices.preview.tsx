import { DeviceBodySkeleton } from "../ui/skeleton";
import { createFileRoute, useBlocker } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { createSignal, Show } from "solid-js";
import { KoboPreviewPage } from "../features/devices/kobo-preview";
import { useDeviceManager, useOptionalDevice } from "../features/devices/context";
import { TypesetPage, type ProfileApi } from "../features/kindle/typeset/preview-page";
import { authenticated } from "../server/functions";
import { createTypesetProfile, deleteTypesetProfile, listTypesetProfiles, updateTypesetProfile } from "../server/typeset/functions";
import { profileSettings as legacySettings } from "../client/kindle/profiles";
import type { TypesettingProfile } from "../client/kindle/profiles";
import "../features/kindle/typeset/typeset.css";

const getPreview = createServerFn({ method: "GET" }).middleware([authenticated]).validator((book: string) => typeof book === "string" ? book : "")
  .handler(async ({ context, data }) => (await import("../features/kindle/typeset/preview.server")).previewData(context.library, data));
const getChapters = createServerFn({ method: "GET" }).middleware([authenticated]).validator((book: string) => typeof book === "string" ? book : "")
  .handler(async ({ context, data }) => (await import("../features/kindle/typeset/preview.server")).previewChapters(context.library, data));
const legacyProfile = (profile: { id: string; name: string; settings: unknown; builtIn: boolean }, deviceId: string): TypesettingProfile => ({ ...profile, deviceId, settings: legacySettings(profile.settings) });
const profileApi: ProfileApi = {
  list: async deviceId => (await listTypesetProfiles({ data: deviceId })).map(profile => legacyProfile(profile, deviceId)),
  create: async profile => legacyProfile(await createTypesetProfile({ data: profile }), profile.deviceId),
  update: async profile => legacyProfile(await updateTypesetProfile({ data: profile }), profile.deviceId),
  delete: (_deviceId, id) => deleteTypesetProfile({ data: { id } }),
};
export const Route = createFileRoute("/_app/devices/preview")({
  pendingComponent: DeviceBodySkeleton,
  validateSearch: (search: Record<string, unknown>): { book?: string; font?: string } => ({
    ...(typeof search.book === "string" ? { book: search.book } : {}),
    ...(typeof search.font === "string" ? { font: search.font.slice(0, 200) } : {}),
  }),
  loaderDeps: ({ search }) => ({ book: search.book ?? "" }),
  loader: ({ deps }) => getPreview({ data: deps.book }),
  head: () => ({ meta: [{ title: "排版与预览 · 设备 · Bindery" }] }),
  component: PreviewRoute,
});
function PreviewRoute() {
  const data = Route.useLoaderData(), search = Route.useSearch(), manager = useDeviceManager(), context = useOptionalDevice();
  const [dirty, setDirty] = createSignal(false);
  useBlocker({ shouldBlockFn: () => dirty() && !window.confirm("当前排版有未保存的修改，确定离开吗？"), enableBeforeUnload: dirty });
  const kind = () => context?.kind();
  return <Show when={kind() === "kobo"} fallback={<TypesetPage manager={manager} data={data()} initialFont={search().font} profiles={profileApi} chapters={bookId => getChapters({ data: bookId })} onDirty={setDirty} />}>
    <KoboPreviewPage data={data()} chapters={bookId => getChapters({ data: bookId })} />
  </Show>;
}
