import TablerDeviceTablet from "~icons/tabler/device-tablet";
import TablerLetterCase from "~icons/tabler/letter-case";
import TablerRefresh from "~icons/tabler/refresh";
import TablerSend from "~icons/tabler/send";
import { DeviceSkeleton } from "../ui/skeleton";
import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../server/functions";
import { createFileRoute, Outlet, useLocation } from "@tanstack/solid-router";
import { For, Show } from "solid-js";
import { Link } from "../shared/spa-link";
import { Icon } from "../ui";
import { DeviceProvider, useDevice } from "../features/devices/context";
import { DeviceConnectPage } from "../features/devices/connect";
import { syncKoboDevice } from "../features/devices/kobo-sync";
import { syncKindleDevice } from "../features/devices/kindle-sync";
import { DeviceBar } from "../features/devices/device-bar";
import "../features/kindle/devices/devices.css";
import "../features/devices/devices-v2.css";

const loadDevicePage = createServerFn({ method: "GET" }).middleware([authenticated])
  .validator((input: { deviceId: string; bookId: string }) => {
    if (!input || typeof input.deviceId !== "string" || typeof input.bookId !== "string" || !/^[\w-]{1,128}$/.test(input.deviceId) || !/^[\w-]{1,128}$/.test(input.bookId)) throw new Error("无效的设备或书籍");
    return input;
  }).handler(async ({ context, data }) => (await import("../features/devices/preview/preview.server")).devicePageSample(context.library, data.deviceId, data.bookId));

export const Route = createFileRoute("/_app/devices")({
  pendingComponent: DeviceSkeleton,
  head: () => ({ meta: [{ title: "设备 · Bindery" }] }),
  component: DeviceLayout,
});

function DeviceContent() {
  const location = useLocation(), device = useDevice();
  const path = () => location().pathname.replace(/\/$/, "");
  const standalone = () => path() === "/devices/preview" || path() === "/devices/connect";
  return <div class="kindle-page kindle-device-content">
    <Show when={!standalone()}><Show when={device.ready() && device.state().status === "granted"} fallback={<DeviceConnectPage />}><DeviceBar compact={path() === "/devices/fonts"} loadPage={(deviceId, bookId) => loadDevicePage({ data: { deviceId, bookId } })} /></Show></Show>
    <Show when={standalone() || path() === "/devices/transfer" || device.ready() && device.state().status === "granted"}><Outlet /></Show>
  </div>;
}
function DeviceLayout() {
  return (
    <DeviceProvider koboReadingSync={syncKoboDevice} kindleReadingSync={syncKindleDevice}>
      <section class="kindle-mobile-note" aria-label="桌面端使用提示">
        <div class="device-mobile-hero">
          <p class="device-mobile-eyebrow">设备</p>
          <h1 class="page-title">阅读器要在<br />电脑上连接。</h1>
          <p class="device-mobile-lead">手机浏览器读不到 Kindle 和 Kobo 的存储。在电脑上用 Chrome 或 Edge 打开 Bindery，插上阅读器就能用。</p>
        </div>
        <section class="device-mobile-features" aria-labelledby="desktop-device-features"><h2 id="desktop-device-features">在电脑上可以</h2>
          <ul><For each={[{ icon: TablerSend, text: "把书库里的书发到阅读器" }, { icon: TablerLetterCase, text: "给阅读器装字体" }, { icon: TablerDeviceTablet, text: "看书在阅读器上的排版" }, { icon: TablerRefresh, text: "同步阅读进度和生词" }] as const}>{item => <li><span aria-hidden="true"><Icon icon={item.icon} size={20} /></span>{item.text}</li>}</For></ul>
          <p class="device-mobile-note">同步过来的进度和生词，在手机上的书库和<Link href="/vocabulary">生词本</Link>里都能看到。</p>
        </section>
        <Link class="btn btn-primary" href="/">回书库</Link>
      </section>
      <DeviceContent />
    </DeviceProvider>
  );
}
