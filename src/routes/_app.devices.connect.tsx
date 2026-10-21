import { createFileRoute } from "@tanstack/solid-router";
import { DeviceConnectPage } from "../features/devices/connect";
export const Route = createFileRoute("/_app/devices/connect")({
  component: DeviceConnectPage,
});
