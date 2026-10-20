export function jobsSearch(input: Record<string, unknown>) {
  const raw = input.jobs_page;
  const invalid = raw !== undefined && !/^[+-]?\d+(?:\.0+)?$/.test(String(raw).trim());
  return { tab: typeof input.jobs_tab === "string" ? input.jobs_tab : "all", page: Number(raw) || 1, invalid };
}
export function jobsSheetOpen(href: string) {
  const url = new URL(href, "http://bindery.local");
  return url.searchParams.has("jobs_tab") || url.hash === "#jobs";
}
export function jobsSheetTarget(href: string, open: boolean) {
  const url = new URL(href, "http://bindery.local");
  if (open) { if (!url.searchParams.has("jobs_tab")) url.searchParams.set("jobs_tab", "all"); url.hash = "jobs"; }
  else { url.searchParams.delete("jobs_tab"); url.searchParams.delete("jobs_page"); if (url.hash === "#jobs") url.hash = ""; }
  return `${url.pathname}${url.search}${url.hash}`;
}
export function legacyJobsTarget(search: string) {
  const query = new URLSearchParams(search), target = new URLSearchParams();
  target.set("jobs_tab", query.get("tab") || "all");
  target.set("jobs_page", query.get("page") ?? "1");
  return `/ingest?${target}#jobs`;
}
