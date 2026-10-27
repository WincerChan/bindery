/** Promote the old theme tab, preserving selection, errors, and fragment state. */
export function legacyThemeTarget(href: string): string | null {
  const url = new URL(href, "http://bindery.local");
  if (url.pathname.replace(/\/$/, "") !== "/rules" || url.searchParams.get("tab")?.trim() !== "themes") return null;
  url.searchParams.delete("tab");
  url.searchParams.delete("rule_id");
  return `/themes${url.search}${url.hash}`;
}
export function legacyThemeRedirect(href: string) {
  const target = legacyThemeTarget(href);
  return target ? { href: target, replace: true, statusCode: 308 } as const : null;
}
