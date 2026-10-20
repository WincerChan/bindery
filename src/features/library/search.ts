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
  return { search: normalizeSearch(input), invalid };
}
export function libraryReturnTo(input: Record<string, unknown>): string {
  const search = normalizeSearch(input);
  return "/?" + new URLSearchParams(Object.entries(search).filter(([key, value]) => key !== "scope" || value !== "active").map(([key, value]) => [key, String(value)]));
}
export const bookHref = (id: string, returnTo: string, preview = false) =>
  `/book/${id}${preview ? "/preview" : ""}?return_to=${encodeURIComponent(returnTo)}`;
export const gridPageSize = (width: number, gap = 20) => Math.max(4, Math.min(96, Math.max(1, Math.floor((width + gap) / (136 + gap))) * 4));
export function selectionInput(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((id): id is string => typeof id === "string") ? value : null;
}
