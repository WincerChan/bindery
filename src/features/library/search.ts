export interface LibrarySearch {
  scope: "active" | "archived";
  sort: "created" | "updated";
  q: string;
  page: number;
  read_filter: "all" | "unread";
  per_page: number;
}
const integer = (value: unknown, fallback: number) => {
  const number = typeof value === "number" ? value : typeof value === "string" && /^[+-]?\d+(?:\.0+)?$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isSafeInteger(number) ? number : fallback;
};
export function normalizeSearch(input: Record<string, unknown>): LibrarySearch {
  const scope = String(input.scope || "").trim().toLowerCase() === "archived" ? "archived" : "active";
  return {
    scope,
    sort: String(input.sort || "").trim().toLowerCase() === "created" ? "created" : "updated",
    q: input.q === undefined ? "" : String(input.q),
    page: Math.max(1, integer(input.page, 1)),
    read_filter: scope !== "archived" && String(input.read_filter || "").trim().toLowerCase() === "unread" ? "unread" : "all",
    per_page: Math.max(4, Math.min(96, integer(input.per_page, 24))),
  };
}
export function libraryQueryInput(input: Record<string, unknown>) {
  const invalid = ["page", "per_page"].some(key => input[key] !== undefined && !Number.isSafeInteger(integer(input[key], NaN)));
  return { search: normalizeSearch(input), invalid, perPageGiven: input.per_page !== undefined };
}
/** The grid's measured page size, so a plain `/` loads it at once instead of loading 24 and then re-sizing. */
export const GRID_PAGE_SIZE_COOKIE = "bindery_grid_per_page";
export function gridPageSizeFromCookie(header: string | null): number | null {
  const match = new RegExp(`(?:^|;\\s*)${GRID_PAGE_SIZE_COOKIE}=(\\d{1,3})(?:;|$)`).exec(header ?? "");
  const value = match ? Number(match[1]) : NaN;
  return value >= 4 && value <= 96 ? value : null;
}
export function rememberGridPageSize(perPage: number) {
  try { document.cookie = `${GRID_PAGE_SIZE_COOKIE}=${perPage}; path=/; max-age=31536000; samesite=lax`; } catch { /* Only a re-size saving. */ }
}
export function libraryReturnTo(input: Record<string, unknown>): string {
  const search = normalizeSearch(input);
  return "/?" + new URLSearchParams(Object.entries(search).filter(([key, value]) => key !== "scope" || value !== "active").map(([key, value]) => [key, String(value)]));
}
export const bookHref = (id: string, returnTo: string, preview = false) =>
  `/book/${id}${preview ? "/preview" : ""}?return_to=${encodeURIComponent(returnTo)}`;
/** Opens the device transfer page with these library books already selected. */
export const deviceTransferHref = (ids: readonly string[]) => `/devices/transfer?books=${ids.map(encodeURIComponent).join(",")}`;
/** Opens the device typesetting preview with this book already chosen. */
export const devicePreviewHref = (id: string) => `/devices/preview?book=${encodeURIComponent(id)}`;
/** Book ids handed over by deviceTransferHref; anything malformed is dropped. */
export function transferSelection(value: unknown): string[] {
  return typeof value === "string" ? [...new Set(value.split(",").filter(id => /^[a-f0-9]{32}$/.test(id)))].slice(0, 500) : [];
}
export const gridPageSize = (width: number, gap = 20) => Math.max(4, Math.min(96, Math.max(1, Math.floor((width + gap) / (136 + gap))) * 4));
export function selectionInput(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((id): id is string => typeof id === "string") ? value : null;
}
