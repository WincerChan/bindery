/** urllib.parse.quote(..., safe="") also escapes these five URI characters. */
export const quoteComponent = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
/** the legacy implementation's return navigation drops fragments and URI path parameters. */
export function safeInternalTarget(target: unknown, fallback = "/"): string {
  const raw =
    typeof target === "string" ? target.trim().replace(/[\t\r\n]/g, "") : "";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\"))
    return fallback;
  const pathQuery = raw.split("#", 1)[0],
    q = pathQuery.indexOf("?");
  const path = q < 0 ? pathQuery : pathQuery.slice(0, q),
    query = q < 0 ? "" : pathQuery.slice(q);
  // urlparse treats only the final path segment's semicolon suffix as params.
  return path.replace(/;[^/]*$/, "") + query;
}
export function bookNavigation(id: string, returnTo: unknown) {
  const return_to = safeInternalTarget(returnTo),
    query = return_to === "/" ? "" : `?return_to=${quoteComponent(return_to)}`;
  return {
    return_to,
    return_to_query: query,
    detail_url: `/book/${id}${query}`,
    edit_url: `/book/${id}/edit${query}`,
    preview_url: `/book/${id}/preview${query}`,
  };
}
