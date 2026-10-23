import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BinderyDatabase, connect } from "../src/server/db";
import { LibraryStorage } from "../src/server/storage";
import { signIn } from "../src/server/auth";
import { TypesetProfiles, DeviceTypeset } from "../src/server/typeset/profiles";
import { EMPTY_SETTINGS, generateProfileCss, profileInput, profileSettings, type TypesettingProfile } from "../src/client/devices/profiles";

const scope = vi.hoisted(() => ({ request: null as Request | null, library: null as LibraryStorage | null }));
vi.mock("../src/server/runtime", () => ({ getLibrary: () => scope.library }));
vi.mock("@tanstack/solid-start/server", () => ({ getRequest: () => scope.request, setResponseStatus: () => {} }));
vi.mock("@tanstack/solid-router", async () => {
  const { createRequire } = await import("node:module"), require = createRequire(import.meta.url);
  return import(createRequire(require.resolve("@tanstack/solid-router")).resolve("@tanstack/router-core"));
});
vi.mock("@tanstack/solid-start", () => ({
  createMiddleware: () => ({ server: (handler: unknown) => ({ options: { server: handler } }) }),
  createServerFn: (options: unknown) => {
    const result = { options, middlewares: [] as unknown[], validate: (v: unknown) => v, middleware(values: unknown[]) { this.middlewares = values; return this; }, validator(validator: (value: unknown) => unknown) { this.validate = validator; return this; }, handler(handler: unknown) { return { ...this, execute: handler }; } };
    return result;
  },
}));
import { listTypesetProfiles, createTypesetProfile, updateTypesetProfile, deleteTypesetProfile, getDeviceTypeset, saveDeviceTypeset } from "../src/server/typeset/functions";
interface TestFunction { middlewares: Array<{ options: { server: (input: { next: (value: { context: { library: LibraryStorage } }) => unknown }) => Promise<unknown> } }>; validate: (value: unknown) => unknown; execute: (input: { context: { library: LibraryStorage }; data: unknown }) => Promise<unknown> }
async function invoke(fn: unknown, input: unknown) {
  const rpc = fn as TestFunction;
  expect(rpc.middlewares).toHaveLength(1);
  return rpc.middlewares[0]!.options.server({ next: ({ context }) => rpc.execute({ context, data: rpc.validate(input) }) });
}
const root = mkdtempSync(join(tmpdir(), "bindery-typeset-profiles-")); let sequence = 0;
beforeEach(() => { const path = join(root, String(sequence++)); scope.library = new LibraryStorage(join(path, "library"), new BinderyDatabase(join(path, "data.db"))); scope.library.ensure(); scope.request = new Request("http://localhost/devices"); });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const input = (settings: Record<string, unknown> = {}) => ({ name: "正文", settings: { ...EMPTY_SETTINGS, marginX: 0.5, marginXUnit: "em" as const, marginY: 0.75, paragraphSpacing: 0.25, lineHeight: 1.5, textIndent: 2, justify: true, fontFamily: "Book Serif", customCss: "h1 { text-align: center; }", ...settings } });
const deviceInput = (settings: Record<string, unknown> = {}) => ({ deviceId: "device-a", kind: "kindle", settings: { margin: "narrow", scale: 1, lineHeight: 1.75, ...settings } });

describe("shared profile validation and CSS", () => {
  it("round-trips ranges, custom CSS and font-name quoting through the shared validator", () => {
    const value = input();
    expect(profileInput(value)).toEqual({ name: "正文", settings: value.settings });
    expect(generateProfileCss({ id: "custom", name: "正文", builtIn: false, settings: value.settings })).toBe('body > * {\n  margin-left: 0.5em !important;\n  margin-right: 0.5em !important;\n}\n\np {\n  line-height: 1.5 !important;\n  margin-top: 0 !important;\n  margin-bottom: 0.25em !important;\n  text-indent: 2em !important;\n  text-align: justify !important;\n}\n\nbody, body * {\n  font-family: "Book Serif" !important;\n}\n\nh1 { text-align: center; }');
    for (const settings of [{ customCss: "p {" }, { marginX: -41, marginXUnit: "percent" }, { lineHeight: Number.NaN }, { fontFamily: "bad\nfont" }, { marginX: 20.1, marginXUnit: "em" }]) expect(() => profileInput(input(settings))).toThrow();
    expect(generateProfileCss({ id: "custom", name: "正文", builtIn: false, settings: { ...EMPTY_SETTINGS, fontFamily: 'a"; } body { color: red; } /*' } })).toContain('font-family: "a\\"; } body { color: red; } /*"');
    expect(profileSettings({ ...EMPTY_SETTINGS, marginX: -4.9, marginXUnit: "percent" }).marginX).toBe(-4.9);
    expect(profileSettings({ ...EMPTY_SETTINGS, marginX: -35, marginXUnit: "percent" }).marginX).toBe(-35);
    expect(profileSettings({ ...EMPTY_SETTINGS, marginX: -20, marginXUnit: "em" }).marginX).toBe(-20);
    expect(() => profileSettings({ ...EMPTY_SETTINGS, marginX: -20.1, marginXUnit: "em" })).toThrow("−20–20em");
    const legacy = { deviceModel: "KPW3", kindleMargin: "narrow", marginX: -0.8 };
    expect(profileSettings(legacy)).toMatchObject({ marginX: -0.8, marginXUnit: "em" });
    expect(() => profileSettings({ ...legacy, deviceModel: 3 })).toThrow("deviceModel");
    expect(() => profileSettings({ ...legacy, kindleMargin: null })).toThrow("kindleMargin");
  });
});

describe("global profile CRUD", () => {
  it("round-trips toggles and negative values through settings_json and keeps the default immutable", () => {
    const profiles = new TypesetProfiles(scope.library!.db), settings = { ...EMPTY_SETTINGS, marginX: -4.9, marginXUnit: "percent" as const, stripFonts: true, stripImages: true, stripPageMargins: true, justify: false, lineHeight: 1.9, customCss: "p { color: red; }" };
    const created = profiles.create({ name: "我的排版", settings });
    expect(created).not.toHaveProperty("deviceId");
    expect(profiles.list()).toEqual([expect.objectContaining({ id: "default", builtIn: true }), created]);
    expect(new TypesetProfiles(scope.library!.db).list()[1]).toEqual(created);
    expect(JSON.parse(scope.library!.db.get<{ settings_json: string }>("SELECT settings_json FROM typeset_profiles WHERE id = ?", created.id)!.settings_json)).toEqual(profileSettings(settings));
    const updated = profiles.update({ ...created, name: "更新", settings: { ...settings, stripFonts: false, marginX: -35 } });
    expect(new TypesetProfiles(scope.library!.db).list()[1]).toEqual(updated);
    const throws = (action: () => unknown) => { try { action(); } catch (error) { return error; } };
    expect(throws(() => profiles.update({ ...input(), id: "default" }))).toMatchObject({ status: 400 });
    expect(throws(() => profiles.delete({ id: "default" }))).toMatchObject({ status: 400 });
    expect(throws(() => profiles.update({ ...input(), id: "missing" }))).toMatchObject({ status: 404 });
    expect(throws(() => profiles.delete({ id: "missing" }))).toMatchObject({ status: 404 });
    profiles.delete({ id: created.id }); expect(profiles.list()).toHaveLength(1);
  });
  it("stays idempotent across repeated db.init() calls and leaves legacy DDL and rows unchanged", () => {
    const dir = join(root, String(sequence++)), path = join(dir, "data.db"), conn = connect(path);
    conn.exec("CREATE TABLE kindle_profiles (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, name TEXT NOT NULL, settings_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE INDEX kindle_profiles_device ON kindle_profiles(device_id)");
    conn.prepare("INSERT INTO kindle_profiles(id, device_id, name, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("legacy", "device-a", "旧方案", JSON.stringify({ deviceModel: "KPW3", kindleMargin: "narrow", marginX: -0.8 }), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    const legacySchema = conn.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name = 'kindle_profiles' ORDER BY type, name").all(), legacyRows = conn.prepare("SELECT * FROM kindle_profiles ORDER BY id").all();
    conn.close();
    const db = new BinderyDatabase(path); db.init(); db.init(); db.init();
    expect(db.all("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name = 'kindle_profiles' ORDER BY type, name")).toEqual(legacySchema);
    expect(db.all("SELECT * FROM kindle_profiles ORDER BY id")).toEqual(legacyRows);
    expect(new TypesetProfiles(db).list().map(profile => profile.id)).toEqual(["default", "legacy"]);
    expect(db.get("SELECT value FROM app_settings WHERE key = 'typeset_profiles_migrated'")).toMatchObject({ value: expect.any(String) });
  });
});

describe("typeset RPCs", () => {
  it("checks real authentication before all six handlers and persists authenticated changes", async () => {
    const calls: Array<[unknown, unknown]> = [[listTypesetProfiles, undefined], [createTypesetProfile, input()], [updateTypesetProfile, { ...input(), id: "missing" }], [deleteTypesetProfile, { id: "missing" }], [getDeviceTypeset, { deviceId: "device-a", kind: "kindle" }], [saveDeviceTypeset, deviceInput()]];
    for (const [fn, value] of calls) await expect(invoke(fn, value)).rejects.toMatchObject({ options: { href: "/login?next=%2F" } });
    scope.request = new Request("http://localhost/devices", { headers: { Cookie: `bindery_session=${signIn(scope.library!.db)}` } });
    expect(await invoke(listTypesetProfiles, undefined) as TypesettingProfile[]).toHaveLength(1);
    const created = await invoke(createTypesetProfile, input()) as TypesettingProfile; expect(created.name).toBe("正文");
    const updated = await invoke(updateTypesetProfile, { ...input(), id: created.id, name: "RPC 更新" }) as TypesettingProfile; expect(updated.name).toBe("RPC 更新");
    expect((await invoke(listTypesetProfiles, undefined) as TypesettingProfile[])[1]).toEqual(updated);
    await invoke(saveDeviceTypeset, deviceInput({ margin: "wide", scale: 1.2, lineHeight: 1.8 })); expect(await invoke(getDeviceTypeset, { deviceId: "device-a", kind: "kindle" })).toEqual({ margin: "wide", scale: 1.2, lineHeight: 1.8 });
    expect(new DeviceTypeset(scope.library!.db).get("device-a", "kindle")).toEqual({ margin: "wide", scale: 1.2, lineHeight: 1.8 });
    await invoke(deleteTypesetProfile, { id: created.id }); expect(await invoke(listTypesetProfiles, undefined) as TypesettingProfile[]).toHaveLength(1);
  });
});
