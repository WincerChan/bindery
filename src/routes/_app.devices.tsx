import { DeviceSkeleton } from "../ui/skeleton";
import { createFileRoute, Outlet, useLocation } from "@tanstack/solid-router";
import { For, Show } from "solid-js";
import { Link } from "../shared/spa-link";
import { DeviceProvider } from "../features/devices/context";
import { syncKoboDevice } from "../features/devices/kobo-sync";
import { syncKindleDevice } from "../features/devices/kindle-sync";
import { DeviceBar } from "../features/devices/device-bar";
import { DeviceTabs } from "../features/devices/tabs";
import "../features/kindle/devices/devices.css";

export const Route = createFileRoute("/_app/devices")({
  pendingComponent: DeviceSkeleton,
  head: () => ({ meta: [{ title: "设备 · Bindery" }] }),
  component: DeviceLayout,
});

function DeviceLayout() {
  const location = useLocation();
  const connecting = () => location().pathname.replace(/\/$/, "") === "/devices/connect";
  return (
    <DeviceProvider koboReadingSync={syncKoboDevice} kindleReadingSync={syncKindleDevice}>
      <section class="kindle-mobile-note" aria-label="桌面端使用提示">
        <p class="muted">设备</p>
        <h1 class="page-title">阅读器要在电脑上连接。</h1>
        <p class="muted">手机浏览器读不到 Kindle 和 Kobo 的存储。在电脑上用 Chrome 或 Edge 打开 Bindery，插上阅读器就能用。</p>
        <section aria-labelledby="desktop-device-features"><h2 id="desktop-device-features">在电脑上可以</h2>
          <ul><For each={["把书库里的书发到阅读器", "给阅读器装字体", "看书在阅读器上的排版", "同步阅读进度和生词"]}>{text => <li>{text}</li>}</For></ul>
          <p class="muted">同步过来的进度和生词，在手机上的书库和<Link href="/vocabulary">生词本</Link>里都能看到。</p>
        </section>
        <Link class="btn btn-primary" href="/">回书库</Link>
      </section>
      <div class={`kindle-page kindle-device-content ${connecting() ? "kindle-connect-page" : ""}`}>
        <Show when={!connecting()}><DeviceBar /><DeviceTabs /></Show>
        <Outlet />
      </div>
    </DeviceProvider>
  );
}
