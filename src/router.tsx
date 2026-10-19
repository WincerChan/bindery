import { createRouter } from "@tanstack/solid-router";
import { routeTree } from "./routeTree.gen";
export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true, defaultNotFoundComponent: NotFound });
}
function NotFound() {
  return (
    <main class="auth-page">
      <h1>页面不存在</h1>
      <p class="muted">这个页面可能还没有迁移到新版，或者地址有误。</p>
      <p><a href="/">返回书库</a></p>
    </main>
  );
}
declare module "@tanstack/solid-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
