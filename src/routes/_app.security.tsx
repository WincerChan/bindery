import { createFileRoute } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../server/functions";
import { SecurityScreen } from "../features/auth/security-screen";
const getSecurityData = createServerFn({
  method: "GET"
}).middleware([authenticated]).handler(async () => (await import("../server/auth-views")).securityData());
export const Route = createFileRoute("/_app/security")({
  loader: () => getSecurityData(),
  head: () => ({
    meta: [{
      title: "安全 · Bindery"
    }]
  }),
  component: Security
});
function Security() {
  const data = Route.useLoaderData();
  return <SecurityScreen data={data()} />;
}
