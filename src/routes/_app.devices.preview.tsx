import { DeviceBodySkeleton } from "../ui/skeleton";
import { createFileRoute, useBlocker } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { createSignal, Show } from "solid-js";
import { useDeviceManager, useOptionalDevice } from "../features/devices/context";
import { TypesetPage, type ProfileApi } from "../features/kindle/typeset/preview-page";
import { authenticated } from "../server/functions";
import { createKindleProfile, deleteKindleProfile, listKindleProfiles, updateKindleProfile } from "../server/kindle/functions";
import "../features/kindle/typeset/typeset.css";

const getPreview = createServerFn({ method: "GET" }).middleware([authenticated]).validator((book: string) => typeof book === "string" ? book : "")
  .handler(async ({ context, data }) => (await import("../features/kindle/typeset/preview.server")).previewData(context.library, data));
const getChapters = createServerFn({ method: "GET" }).middleware([authenticated]).validator((book: string) => typeof book === "string" ? book : "")
  .handler(async ({ context, data }) => (await import("../features/kindle/typeset/preview.server")).previewChapters(context.library, data));
const profileApi: ProfileApi = {
  list: deviceId => listKindleProfiles({ data: deviceId }),
  create: profile => createKindleProfile({ data: profile }),
  update: profile => updateKindleProfile({ data: profile }),
  delete: (deviceId, id) => deleteKindleProfile({ data: { deviceId, id } }),
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
    <section class="kt-page" aria-label="排版与预览"><div class="kt-heading"><div><h2>排版与预览</h2><p class="muted">Kobo 的排版预览将在真机校准后提供。第一期可使用传书页的「去字体 / 去图片」选项；KEPUB 会保留书籍自带排版。</p></div></div></section>
  </Show>;
}
