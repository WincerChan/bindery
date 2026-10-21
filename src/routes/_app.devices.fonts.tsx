import { DeviceBodySkeleton } from "../ui/skeleton";
import { createFileRoute } from "@tanstack/solid-router";
import { useDeviceManager } from "../features/devices/context";
import { FontsPage } from "../features/kindle/typeset/fonts-page";
import "../features/kindle/typeset/typeset.css";
export const Route = createFileRoute("/_app/devices/fonts")({
  pendingComponent: DeviceBodySkeleton,
  head: () => ({ meta: [{ title: "字体 · 设备 · Bindery" }] }),
  component: FontsRoute,
});
function FontsRoute() {
  const navigate = Route.useNavigate(), manager = useDeviceManager();
  return <FontsPage manager={manager} onPreview={font => navigate({ to: "/devices/preview", search: { font } })} />;
}
