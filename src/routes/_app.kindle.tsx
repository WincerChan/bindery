import { createFileRoute, Outlet, useRouter } from "@tanstack/solid-router";
import { KindleProvider } from "../features/kindle/context";
import { KindleDeviceBar } from "../features/kindle/device-bar";
import { KindleTabs } from "../features/kindle/tabs";
import { navigateKindleLink } from "../features/kindle/devices/navigation";
import "../features/kindle/devices/devices.css";

export const Route = createFileRoute("/_app/kindle")({
  head: () => ({ meta: [{ title: "Kindle · Bindery" }] }),
  component: KindleLayout,
});

function KindleLayout() {
  const router = useRouter();
  return (
    <KindleProvider>
      <div class="kindle-page" onClick={event => { void navigateKindleLink(event, href => router.navigate({ href }), window.location); }}>
        <KindleDeviceBar />
        <KindleTabs />
        <Outlet />
      </div>
    </KindleProvider>
  );
}
