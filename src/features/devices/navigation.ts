import { useRouter } from "@tanstack/solid-router";

/** Menus expose actions, while covers keep real links for modifier-clicks. */
export function useDeviceNavigation() {
  const router = useRouter({ warn: false });
  return (href: string) => {
    if (!router) { window.location.assign(href); return; }
    const url = new URL(href, "http://bindery.invalid");
    void router.navigate({ to: url.pathname, search: () => router.options.parseSearch!(url.search), hash: url.hash.slice(1) });
  };
}
