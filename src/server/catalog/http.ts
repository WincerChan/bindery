import type { ApiContext } from "../http";
import { HttpError } from "../http";
import { redirect } from "../auth-http";
import { deleteTemplate, newTemplate, saveRule, saveTheme, testRule } from "./templates";
import { duplicateCheck, removeTracker, trackerCsv, writeTracker } from "./tracker";

async function fields(request: Request) {
  const data = await request.formData();
  return Object.fromEntries([...data].map(([key, value]) => [key, typeof value === "string" ? value : ""]));
}
const wantsJson = (request: Request) => request.headers.get("Accept")?.includes("application/json");
// Starlette RedirectResponse quotes Unicode and spaces while preserving URL delimiters and %.
const quotedLocation = (target: string) => Array.from(target).map(char => /^[A-Za-z0-9\-_.~:/%#?=@[\]!$&'()*+,;]$/.test(char) ? char : encodeURIComponent(char)).join("");
function templateRedirect(request: Request, target: string) {
  return request.headers.get("HX-Request") === "true" ? new Response("", { headers: { "HX-Redirect": target, "Content-Type": "text/html; charset=utf-8" } }) : redirect(target);
}
export const createTemplateHandler = (kind: "rules" | "themes") => ({ request }: ApiContext<unknown>) => templateRedirect(request, newTemplate(kind));
export const deleteTemplateHandler = (kind: "rules" | "themes") => ({ request, params, library }: ApiContext<{ rule_id?: string; theme_id?: string }>) => templateRedirect(request, deleteTemplate(kind, (kind === "rules" ? params.rule_id : params.theme_id)!, library));
export const saveEditorHandler = (kind: "rules" | "themes") => async ({ request, params }: ApiContext<{ rule_id?: string; theme_id?: string }>) => {
  const body = await fields(request), data = kind === "rules" ? saveRule(params.rule_id!, body.config_json || "") : saveTheme(params.theme_id!, body.css || "");
  if (wantsJson(request)) return Response.json(data);
  const { editorResponse } = await import("./responses");
  return editorResponse(data, kind);
};
export async function testRuleHandler({ request }: ApiContext<unknown>) {
  const body = await fields(request), result = testRule(body.sample || "", body.rule_template || "default");
  if (wantsJson(request)) return Response.json(result);
  const { previewResponse } = await import("./responses"); return previewResponse(result);
}
export async function writeTrackerHandler({ request, params, library }: ApiContext<{ wish_id?: string }>) {
  const target = writeTracker(library, await fields(request), params.wish_id);
  return wantsJson(request) ? Response.json({ redirect: quotedLocation(target) }) : redirect(quotedLocation(target));
}
export async function deleteTrackerHandler({ request, params, library }: ApiContext<{ wish_id: string }>) {
  const target = removeTracker(library, params.wish_id, (await fields(request)).next || "");
  return wantsJson(request) ? Response.json({ redirect: quotedLocation(target) }) : redirect(quotedLocation(target));
}
export function duplicateHandler({ request, library }: ApiContext<unknown>) {
  const query = new URL(request.url).searchParams, raw = query.get("limit") ?? "5", limit = Number(raw);
  if (!/^[+-]?\d+$/.test(raw.trim()) || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new HttpError(422, "limit 必须介于 1 和 20 之间");
  return Response.json(duplicateCheck(library, query.get("title") || "", query.get("author") || "", limit));
}
export function exportHandler({ request, library }: ApiContext<unknown>) {
  const date = new Date(), pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return new Response(trackerCsv(library, Object.fromEntries(new URL(request.url).searchParams)), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="bindery-tracker-${stamp}.csv"` } });
}
