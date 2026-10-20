import { createLink, useRouter, type AnyRouter } from "@tanstack/solid-router";
import { createMemo, omit } from "solid-js";
import type { JSX } from "@solidjs/web";

// Legacy POST responses render standalone HTML outside RouterProvider. Within
// the SPA this is always a real Router Link, including modifier-click handling.
export function Link(props: Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "target"> & { href: string; target?: string; replace?: boolean; resetScroll?: boolean; hashScrollIntoView?: boolean }) {
  const router = useRouter({ warn: false });
  if (!router) return <a {...omit(props, "replace", "resetScroll", "hashScrollIntoView")} />;
  const target = createMemo(() => {
    if (props.href.startsWith("#")) return { to: ".", hash: props.href.slice(1), search: true as const };
    const url = new URL(props.href, "http://bindery.invalid");
    return { to: url.pathname, search: () => router.options.parseSearch!(url.search), hash: url.hash.slice(1) };
  });
  // Router supplies its own aria-current based on the whole URL. Callers such
  // as grouped tabs and pagination deliberately define a different current item.
  const RouterLink = createLink((anchor: JSX.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...anchor} aria-current={"aria-current" in props ? props["aria-current"] : anchor["aria-current"]} />);
  return <RouterLink<AnyRouter, string, string> {...omit(props, "href")} {...target()} activeProps={{}} />;
}
