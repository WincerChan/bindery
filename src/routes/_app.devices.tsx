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
      <div class={`kindle-page ${connecting() ? "kindle-connect-page" : ""}`}>
        <Show when={!connecting()}><DeviceBar /><DeviceTabs /></Show>
        <Outlet />
      </div>
    </DeviceProvider>
  );
}
