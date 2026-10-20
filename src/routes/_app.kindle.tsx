import { createFileRoute, Outlet, useLocation, useRouter } from "@tanstack/solid-router";
import { Show } from "solid-js";
import { KindleProvider } from "../features/kindle/context";
import { KindleDeviceBar } from "../features/kindle/device-bar";
import { KindleTabs } from "../features/kindle/tabs";
import { navigateKindleLink } from "../features/kindle/devices/navigation";
import "../features/kindle/devices/devices.css";

export const Route = createFileRoute("/_app/kindle")({
  head: () => ({ meta: [{ title: "设备 · Bindery" }] }),
  component: KindleLayout,
});

function KindleLayout() {
  const router = useRouter(), location = useLocation();
  const connecting = () => location().pathname.replace(/\/$/, "") === "/kindle/connect";
  return (
    <KindleProvider>
      <div class={`kindle-page ${connecting() ? "kindle-connect-page" : ""}`} onClick={event => { void navigateKindleLink(event, href => router.navigate({ href }), window.location); }}>
        <Show when={!connecting()}><KindleDeviceBar /><KindleTabs /></Show>
        <Outlet />
      </div>
    </KindleProvider>
  );
}
