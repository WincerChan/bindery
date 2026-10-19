import { createFileRoute } from "@tanstack/solid-router";
import { KindleConnectPage } from "../features/kindle/devices/connect";
export const Route = createFileRoute("/_app/kindle/connect")({
  component: KindleConnectPage,
});
