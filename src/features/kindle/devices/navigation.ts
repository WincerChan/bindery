/** Keep ordinary Kindle links inside the SPA so navigation cannot interrupt its browser queue. */
export function navigateKindleLink(event: MouseEvent, navigate: (href: string) => unknown, location: Pick<Location, "href" | "origin">) {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const anchor = (event.target as Element | null)?.closest?.("a");
  if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
  const url = new URL(anchor.href, location.href);
  if (url.origin !== location.origin || !/^\/kindle(?:\/|$)/.test(url.pathname) || anchor.getAttribute("href")?.startsWith("#")) return;
  event.preventDefault(); return navigate(`${url.pathname}${url.search}${url.hash}`);
}
