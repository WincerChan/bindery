import { DeviceBodySkeleton } from "../ui/skeleton";
import { createFileRoute, useBlocker } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { createSignal } from "solid-js";
import { useOptionalDevice } from "../features/devices/context";
import { DevicePreviewPage, type ProfileApi, type ReadingApi } from "../features/devices/preview/preview-page";
import { authenticated } from "../server/functions";
import { createTypesetProfile, deleteTypesetProfile, getDeviceTypeset, listTypesetProfiles, saveDeviceTypeset, updateTypesetProfile } from "../server/typeset/functions";
import "../features/devices/preview/typeset.css";

const getPreview = createServerFn({ method: "GET" }).middleware([authenticated]).validator((book: string) => typeof book === "string" ? book : "")
  .handler(async ({ context, data }) => (await import("../features/devices/preview/preview.server")).previewData(context.library, data));
const getChapters = createServerFn({ method: "GET" }).middleware([authenticated]).validator((book: string) => typeof book === "string" ? book : "")
  .handler(async ({ context, data }) => (await import("../features/devices/preview/preview.server")).previewChapters(context.library, data));
const profileApi: ProfileApi = {
  list: () => listTypesetProfiles(),
  create: profile => createTypesetProfile({ data: profile }),
  update: profile => updateTypesetProfile({ data: profile }),
  delete: id => deleteTypesetProfile({ data: { id } }),
};
const readingApi: ReadingApi = {
  get: (deviceId, kind) => getDeviceTypeset({ data: { deviceId, kind } }),
  save: (deviceId, kind, settings) => saveDeviceTypeset({ data: { deviceId, kind, settings } }),
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
  const data = Route.useLoaderData(), search = Route.useSearch(), context = useOptionalDevice();
  const [dirty, setDirty] = createSignal(false);
  useBlocker({ shouldBlockFn: () => dirty() && !window.confirm("当前排版有未保存的修改，确定离开吗？"), enableBeforeUnload: dirty });
  return <DevicePreviewPage data={data()} initialFont={search().font} profiles={profileApi} reading={readingApi} chapters={bookId => getChapters({ data: bookId })} onDirty={setDirty} />;
}
