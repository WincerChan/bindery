import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LibraryStorage } from "../src/server/storage";
import { BinderyDatabase } from "../src/server/db";
import { loadRuleTemplates, loadThemeTemplates, templateDirectory } from "../src/server/templates";
import { settingsSummary } from "../src/server/settings/summary";
import { saveLexiTraceSettings } from "../src/server/vocabulary/settings";
import { signIn } from "../src/server/auth";

const scope = vi.hoisted(() => ({ request: null as Request | null, library: null as LibraryStorage | null }));
vi.mock("../src/server/runtime", () => ({ getLibrary: () => scope.library }));
vi.mock("@tanstack/solid-start/server", () => ({ getRequest: () => scope.request, setResponseStatus: () => {} }));
vi.mock("@tanstack/solid-router", async () => {
  const { createRequire } = await import("node:module"), require = createRequire(import.meta.url);
  return import(createRequire(require.resolve("@tanstack/solid-router")).resolve("@tanstack/router-core"));
});
vi.mock("@tanstack/solid-start", () => ({
  createMiddleware: () => ({ server: (handler: unknown) => ({ options: { server: handler } }) }),
  createServerFn: (options: unknown) => ({
    options, middlewares: [] as unknown[],
    middleware(values: unknown[]) { this.middlewares = values; return this; },
    handler(handler: unknown) { return { ...this, execute: handler }; },
  }),
}));
import { loadSettingsSummary } from "../src/server/settings/functions";
interface TestFunction {
  options: { method: string };
  middlewares: Array<{ options: { server: (input: { next: (value: { context: { library: LibraryStorage } }) => unknown }) => Promise<unknown> } }>;
  execute: (input: { context: { library: LibraryStorage } }) => Promise<unknown>;
}

let root: string, library: LibraryStorage;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bindery-settings-summary-"));
  for (const name of ["BINDERY_RULES_DIR", "BINDERY_THEMES_DIR", "BINDERY_TEMPLATE_DIR"]) { vi.stubEnv(name, ""); vi.stubEnv(`${name}_FILE`, ""); }
  vi.stubEnv("BINDERY_TEMPLATE_DIR", join(root, "templates"));
  library = new LibraryStorage(join(root, "library"), new BinderyDatabase(join(root, "data.db")));
  scope.library = library;
  scope.request = new Request("http://localhost/_serverFn/settings");
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function template(kind: "rules" | "themes", id: string, name: string, version: string, mtime: string) {
  const path = join(templateDirectory(kind), `${id}.json`);
  writeFileSync(path, JSON.stringify({ id, name, version }));
  utimesSync(path, new Date(mtime), new Date(mtime));
}
function passkey(id: string) {
  library.db.insertPasskey({ credential_id: id, public_key: new Uint8Array([1]), sign_count: 0, transports_json: "[]", aaguid: null, device_type: null, backed_up: false, name: id, created_at: "2026-01-01T00:00:00+00:00" });
}
describe("settings hub summary", () => {
  it("exposes a GET RPC guarded by authenticated middleware", async () => {
    const rpc = loadSettingsSummary as unknown as TestFunction;
    expect(rpc.options.method).toBe("GET");
    expect(rpc.middlewares).toHaveLength(1);
    const next = vi.fn(rpc.execute);
    await expect(rpc.middlewares[0].options.server({ next })).rejects.toMatchObject({ options: { href: "/login?next=%2F" } });
    expect(next).not.toHaveBeenCalled();
    library.ensure();
    scope.request = new Request("http://localhost/_serverFn/settings", { headers: { Cookie: `bindery_session=${signIn(library.db)}` } });
    expect(await rpc.middlewares[0].options.server({ next })).toEqual(settingsSummary(library));
    expect(next).toHaveBeenCalledWith({ context: { library } });
  });
  it("includes seeded built-ins and empty security/configuration state", () => {
    const rule = loadRuleTemplates()[0], theme = loadThemeTemplates()[0];
    expect(settingsSummary(library)).toEqual({
      rules: { count: 1, recently_modified: { id: rule.rule_id, name: rule.name } },
      themes: { count: 1, ingest_default: { id: theme.theme_id, name: theme.name, version: theme.version } },
      security: { passkey_count: 0, last_used_at: null },
      lexitrace: { configured: false, enabled: true },
    });
  });
  it("uses rule file mtime, not filename or version, and ingest's explicit default theme", () => {
    template("rules", "alpha", "最近改过", "1", "2026-03-01");
    template("rules", "default", "内置", "99", "2026-01-01");
    template("rules", "z-last", "最后文件名", "3", "2026-02-01");
    template("themes", "alpha", "排序第一", "9", "2026-01-01");
    template("themes", "default", "默认 v2", "2", "2026-01-01");
    expect(settingsSummary(library)).toMatchObject({
      rules: { count: 3, recently_modified: { id: "alpha", name: "最近改过" } },
      themes: { count: 2, ingest_default: { id: "default", name: "默认 v2", version: "2" } },
    });
    utimesSync(join(templateDirectory("rules"), "default.json"), new Date("2026-04-01"), new Date("2026-04-01"));
    expect(settingsSummary(library).rules.recently_modified).toEqual({ id: "default", name: "内置" });
  });
  it("returns null for empty loader results and matches getTheme's fallback when default is invalid", () => {
    for (const kind of ["rules", "themes"] as const) writeFileSync(join(templateDirectory(kind), "default.json"), "{bad");
    expect(settingsSummary(library)).toMatchObject({ rules: { count: 0, recently_modified: null }, themes: { count: 0, ingest_default: null } });
    template("themes", "alpha", "可用主题", "4", "2026-01-01");
    expect(settingsSummary(library).themes).toEqual({ count: 1, ingest_default: { id: "alpha", name: "可用主题", version: "4" } });
  });
  it("counts all passkeys and returns the maximum login usage timestamp, ignoring nulls", () => {
    library.ensure();
    for (const id of ["a", "b", "c"]) passkey(id);
    expect(settingsSummary(library).security).toEqual({ passkey_count: 3, last_used_at: null });
    const latest = "2026-03-04T12:00:00+00:00";
    library.db.updatePasskeyUsage("a", 2, true, latest);
    library.db.updatePasskeyUsage("c", 1, false, "2026-02-01T12:00:00+00:00");
    expect(settingsSummary(library).security).toEqual({ passkey_count: 3, last_used_at: latest });
  });
  it.each([
    ["", "", true, false],
    ["https://lexitrace.example", "", true, false],
    ["", "private-token", true, false],
    ["https://lexitrace.example", "private-token", true, true],
    ["https://lexitrace.example", "private-token", false, true],
    ["", "", false, false],
    ["https://lexitrace.example", "", false, false],
    ["", "private-token", false, false],
  ])("derives safe LexiTrace status (url=%s, token=%s, enabled=%s)", (baseUrl, token, enabled, configured) => {
    library.ensure();
    saveLexiTraceSettings(library.db, { baseUrl, token, enabled });
    library.db.setSetting("unrelated_secret", "private-setting-value");
    const summary = settingsSummary(library);
    expect(summary.lexitrace).toEqual({ configured, enabled });
    const json = JSON.stringify(summary);
    expect(json).not.toContain("private-token");
    expect(json).not.toContain("lexitrace.example");
    expect(json).not.toContain("token");
    // Match field names at any nesting depth, including camelCase/case variants.
    expect(json).not.toMatch(/"[^"]*(?:secret|token)[^"]*"\s*:/i);
    expect(json).not.toContain("private-setting-value");
    expect(json).not.toContain("public_key");
    expect(json).not.toContain(root);
  });
});
