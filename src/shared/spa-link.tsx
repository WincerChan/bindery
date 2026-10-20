import { Link as RouterLink, useRouter, type AnyRouter } from "@tanstack/solid-router";
import { createMemo, omit } from "solid-js";
import type { JSX } from "@solidjs/web";

// Legacy POST responses render standalone HTML outside RouterProvider. Within
// the SPA this is always a real Router Link, including modifier-click handling.
export function Link(props: Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "target"> & { href: string; target?: string }) {
  const router = useRouter({ warn: false });
  if (!router) return <a {...props} />;
  const target = createMemo(() => {
    if (props.href.startsWith("#")) return { to: ".", hash: props.href.slice(1), search: true as const };
    const url = new URL(props.href, "http://bindery.invalid");
    return { to: url.pathname, search: () => router.options.parseSearch!(url.search), hash: url.hash.slice(1) };
  });
  return <RouterLink<AnyRouter, string, string> {...omit(props, "href")} {...target()} activeProps={{}} />;
}
