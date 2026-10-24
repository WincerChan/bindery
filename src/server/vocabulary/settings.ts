import { randomUUID } from "node:crypto";
import type { BinderyDatabase } from "../db";
import { HttpError } from "../http";

const BASE_URL = "lexitrace_base_url", TOKEN = "lexitrace_token", ENABLED = "lexitrace_enabled";
export interface LexiTraceSettings { baseUrl: string; token: string; enabled: boolean }
export interface LexiTraceSettingsView { baseUrl: string; hasToken: boolean; enabled: boolean }
export interface LexiTraceSettingsInput { baseUrl?: unknown; token?: unknown; clearToken?: unknown; enabled?: unknown }

function loopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]" || host === "::1") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}
/** Empty means unconfigured. URLs never carry credentials, queries or fragments. */
export function normalizeLexiTraceBaseUrl(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "LexiTrace 地址无效");
  const raw = value.trim();
  if (!raw) return "";
  if (raw.length > 2048) throw new HttpError(400, "LexiTrace 地址无效");
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new HttpError(400, "LexiTrace 地址无效"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new HttpError(400, "LexiTrace 地址无效");
  if (url.protocol === "http:" && !loopback(url.hostname)) throw new HttpError(400, "LexiTrace 地址必须使用 HTTPS（本机回环地址除外）");
  return url.toString().replace(/\/+$/, "");
}
function normalizeToken(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) throw new HttpError(400, "LexiTrace 令牌无效");
  return value.trim();
}
function stored(db: BinderyDatabase, key: string): string {
  return db.getSetting(key) ?? "";
}
export function lexTraceSettings(db: BinderyDatabase): LexiTraceSettings {
  return { baseUrl: stored(db, BASE_URL), token: stored(db, TOKEN), enabled: stored(db, ENABLED) !== "0" };
}
export function lexTraceSettingsView(db: BinderyDatabase): LexiTraceSettingsView {
  const current = lexTraceSettings(db);
  return { baseUrl: current.baseUrl, hasToken: Boolean(current.token), enabled: current.enabled };
}
export function saveLexiTraceSettings(db: BinderyDatabase, value: unknown): LexiTraceSettingsView {
  const input = value !== null && typeof value === "object" && !Array.isArray(value) ? value as LexiTraceSettingsInput : {};
  if (input.baseUrl !== undefined) db.setSetting(BASE_URL, normalizeLexiTraceBaseUrl(input.baseUrl));
  const token = normalizeToken(input.token);
  if (input.clearToken === true) db.run("DELETE FROM app_settings WHERE key = ?", TOKEN);
  else if (token) db.setSetting(TOKEN, token);
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new HttpError(400, "LexiTrace 启用状态无效");
    db.setSetting(ENABLED, input.enabled ? "1" : "0");
  }
  return lexTraceSettingsView(db);
}
export interface ConnectionTest { ok: boolean; category?: "auth" | "disabled" | "http_error" | "network" | "not_configured"; status?: number; latencyMs: number }
export async function testLexiTraceConnection(db: BinderyDatabase, value: unknown, fetcher: typeof fetch = fetch): Promise<ConnectionTest> {
  const input = value !== null && typeof value === "object" && !Array.isArray(value) ? value as LexiTraceSettingsInput : {};
  const current = lexTraceSettings(db);
  const baseUrl = input.baseUrl === undefined || input.baseUrl === "" ? current.baseUrl : normalizeLexiTraceBaseUrl(input.baseUrl);
  const token = normalizeToken(input.token) || current.token;
  if (!baseUrl || !token) return { ok: false, category: "not_configured", latencyMs: 0 };
  const started = Date.now(), controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetcher(`${baseUrl}/api/integrations/llplayer/lookups/${randomUUID()}`, {
      method: "GET", headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (response.status === 404 || response.status === 200) return { ok: true, status: response.status, latencyMs };
    if (response.status === 401 || response.status === 403) return { ok: false, category: "auth", status: response.status, latencyMs };
    if (response.status === 503) return { ok: false, category: "disabled", status: response.status, latencyMs };
    return { ok: false, category: "http_error", status: response.status, latencyMs };
  } catch { return { ok: false, category: "network", latencyMs: Date.now() - started }; }
  finally { clearTimeout(timer); }
}
export { BASE_URL as LEXITRACE_BASE_URL_KEY, TOKEN as LEXITRACE_TOKEN_KEY, ENABLED as LEXITRACE_ENABLED_KEY };
