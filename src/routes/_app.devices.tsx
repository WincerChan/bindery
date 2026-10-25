import { DeviceSkeleton } from "../ui/skeleton";
import { createFileRoute, Outlet, useLocation } from "@tanstack/solid-router";
import { Show } from "solid-js";
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
        <h1 class="page-title">请在电脑上使用设备功能</h1>
        <p class="muted">当前手机端不支持连接 Kindle / Kobo 和写入传书副本。设备管理、排版、传书与字体安装请在桌面浏览器中完成。</p>
      </section>
      <div class={`kindle-page kindle-device-content ${connecting() ? "kindle-connect-page" : ""}`}>
        <Show when={!connecting()}><DeviceBar /><DeviceTabs /></Show>
        <Outlet />
      </div>
    </DeviceProvider>
  );
}
