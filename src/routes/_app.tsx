import { createFileRoute } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../server/functions";
import { AppShell } from "../shell/app-shell";

const checkSession = createServerFn({ method: "GET" }).middleware([authenticated]).handler(() => true);
export const Route = createFileRoute("/_app")({
  beforeLoad: () => checkSession(),
  component: AppShell,
});
