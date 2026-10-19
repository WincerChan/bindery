import { createFileRoute, Outlet } from "@tanstack/solid-router";
import { KindleProvider } from "../features/kindle/context";
import { KindleDeviceBar } from "../features/kindle/device-bar";
import { KindleTabs } from "../features/kindle/tabs";

export const Route = createFileRoute("/_app/kindle")({
  head: () => ({ meta: [{ title: "Kindle · Bindery" }] }),
  component: KindleLayout,
});

function KindleLayout() {
  return (
    <KindleProvider>
      <div class="kindle-page">
        <KindleDeviceBar />
        <KindleTabs />
        <Outlet />
      </div>
    </KindleProvider>
  );
}
