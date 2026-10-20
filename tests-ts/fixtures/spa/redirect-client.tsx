import { render } from "@solidjs/web";
import { flush, Loading } from "solid-js";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, isRedirect, Outlet, RouterProvider } from "@tanstack/solid-router";
import { useMutation } from "../../../src/shared/client-mutation";

export { isRedirect };
export async function redirectClient(node: HTMLElement, load: () => Promise<unknown>, write: () => Promise<unknown>) {
  let run!: () => Promise<unknown>;
  const root = createRootRoute({ component: () => <Outlet /> });
  const current = createRoute({ getParentRoute: () => root, path: "/current", component: () => {
    const mutation = useMutation(); run = () => mutation.run(write, async () => {}, "不应成功"); return <p>原页面</p>;
  } });
  const protectedPage = createRoute({ getParentRoute: () => root, path: "/protected", loader: load, component: () => <p>不应显示</p> });
  const login = createRoute({ getParentRoute: () => root, path: "/login", validateSearch: (search: Record<string, unknown>) => search, component: () => <p>登录页面</p> });
  const router = createRouter({ routeTree: root.addChildren([current, protectedPage, login]), history: createMemoryHistory({ initialEntries: ["/current?q=one&page=3"] }), isServer: false, origin: "http://localhost" });
  await router.load();
  const dispose = render(() => <Loading><RouterProvider router={router} /></Loading>, node); flush();
  return { router, dispose, flush, run: () => run(), href: () => router.state.location.href, navigate: () => router.navigate({ href: "/protected" }) };
}
