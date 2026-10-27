/** Map a legacy `/kindle*` URL (path + query + hash) to the device URL. */
export function legacyDeviceTarget(href: string): string {
  return href.replace(/^\/kindle(?=\/|$|\?|#)/, "/devices") || "/devices";
}
/** Preserve query/fragment state when promoting the vocabulary page out of devices. */
export function legacyVocabularyTarget(href: string): string {
  return href.replace(/^\/devices\/vocabulary\/?(?=$|\?|#)/, "/vocabulary");
}
export function legacyVocabularyRedirect(href: string) {
  return { href: legacyVocabularyTarget(href), replace: true, statusCode: 308 } as const;
}
export function legacyKindleRedirect(href: string) {
  return { href: legacyDeviceTarget(href), replace: true } as const;
}
