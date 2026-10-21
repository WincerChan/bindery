/** Map a legacy `/kindle*` URL (path + query + hash) to the device URL. */
export function legacyDeviceTarget(href: string): string {
  return href.replace(/^\/kindle(?=\/|$|\?|#)/, "/devices") || "/devices";
}
export function legacyKindleRedirect(href: string) {
  return { href: legacyDeviceTarget(href), replace: true } as const;
}
