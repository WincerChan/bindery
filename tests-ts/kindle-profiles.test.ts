import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BinderyDatabase } from "../src/server/db";
import { LibraryStorage } from "../src/server/storage";
import { signIn } from "../src/server/auth";
import { KindleProfiles } from "../src/server/kindle/profiles";
import { defaultProfile, EMPTY_SETTINGS, generateProfileCss, profileInput } from "../src/client/kindle/profiles";

const scope = vi.hoisted(() => ({ request: null as Request | null, library: null as LibraryStorage | null }));
vi.mock("../src/server/runtime", () => ({ getLibrary: () => scope.library }));
vi.mock("@tanstack/solid-start/server", () => ({ getRequest: () => scope.request, setResponseStatus: () => {} }));
vi.mock("@tanstack/solid-start", () => ({
  createMiddleware: () => ({ server: (handler: unknown) => ({ options: { server: handler } }) }),
  createServerFn: (options: unknown) => {
    const result = { options, middlewares: [] as unknown[], validator: (v: unknown) => v, middleware(values: unknown[]) { this.middlewares = values; return this; }, inputValidator(validator: (value: unknown) => unknown) { this.validator = validator; return this; }, handler(handler: unknown) { return { ...this, execute: handler }; } };
    return result;
  },
}));
import { listKindleProfiles, createKindleProfile, updateKindleProfile, deleteKindleProfile } from "../src/server/kindle/functions";
interface TestFunction { middlewares: Array<{ options: { server: (input: { next: (value: { context: { library: LibraryStorage } }) => unknown }) => Promise<unknown> } }>; validator: (value: unknown) => unknown; execute: (input: { context: { library: LibraryStorage }; data: unknown }) => Promise<unknown> }
async function invoke(fn: unknown, input: unknown) {
  const rpc = fn as TestFunction;
  expect(rpc.middlewares).toHaveLength(1);
  return rpc.middlewares[0].options.server({ next: ({ context }) => rpc.execute({ context, data: rpc.validator(input) }) });
}
const root = mkdtempSync(join(tmpdir(), "bindery-kindle-profiles-")); let sequence = 0;
beforeEach(() => { const path = join(root, String(sequence++)); scope.library = new LibraryStorage(join(path, "library"), new BinderyDatabase(join(path, "data.db"))); scope.library.ensure(); scope.request = new Request("http://localhost/kindle"); });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const input = (deviceId = "device-a") => ({ deviceId, name: "正文", settings: { ...EMPTY_SETTINGS, marginX: 0.5, marginY: 0.75, paragraphSpacing: 0.25, lineHeight: 1.5, textIndent: 2, justify: true, fontFamily: "Book Serif", customCss: "h1 { text-align: center; }" } });

describe("Kindle typesetting profiles", () => {
  it("adds only its optional table, preserves every legacy DDL/row and remains idempotent", () => {
    const db = scope.library!.db; db.run("INSERT INTO app_settings(key, value) VALUES (?, ?)", "kindle-test", "preserve");
    const legacy = db.all("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"), rows = db.all("SELECT * FROM app_settings");
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'kindle_profiles'")).toBeNull();
    const profiles = new KindleProfiles(db), created = profiles.create(input()); db.init(); db.init();
    expect(db.all("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name != 'kindle_profiles' ORDER BY type, name")).toEqual(legacy); expect(db.all("SELECT * FROM app_settings")).toEqual(rows);
    expect(new KindleProfiles(db).list("device-a")).toHaveLength(2); expect(profiles.list("device-a")[1]).toEqual(created);
  });
  it("lists built-in no-CSS default and isolates CRUD by device ID", () => {
    const profiles = new KindleProfiles(scope.library!.db), created = profiles.create(input());
    expect(profiles.list("device-b")).toEqual([defaultProfile("device-b")]); expect(generateProfileCss(profiles.list("device-a")[0])).toBe("");
    expect(() => profiles.update({ ...input("device-b"), id: created.id })).toThrow("不存在"); expect(() => profiles.delete({ deviceId: "device-b", id: created.id })).toThrow("不存在");
    const changed = profiles.update({ ...input(), id: created.id, name: "更新" }); expect(changed.name).toBe("更新");
    expect(() => profiles.delete({ deviceId: "device-a", id: "default" })).toThrow("不可删除"); expect(() => profiles.update({ ...input(), id: "default" })).toThrow("不可修改"); profiles.delete({ deviceId: "device-a", id: created.id }); expect(profiles.list("device-a")).toHaveLength(1);
  });
  it("validates ranges, custom CSS and font quoting through the shared validator", () => {
    const value = input(); expect(generateProfileCss({ ...value, id: "custom", builtIn: false })).toBe('body {\n  margin-left: 0.5em !important;\n  margin-right: 0.5em !important;\n  margin-top: 0.75em !important;\n  margin-bottom: 0.75em !important;\n}\n\np {\n  line-height: 1.5 !important;\n  margin-top: 0 !important;\n  margin-bottom: 0.25em !important;\n  text-indent: 2em !important;\n  text-align: justify !important;\n}\n\nbody, body * {\n  font-family: "Book Serif" !important;\n}\n\nh1 { text-align: center; }');
    for (const settings of [{ ...value.settings, customCss: "p {" }, { ...value.settings, marginX: -1 }, { ...value.settings, lineHeight: NaN }, { ...value.settings, fontFamily: "bad\nfont" }]) expect(() => profileInput({ ...value, settings })).toThrow();
    expect(generateProfileCss({ ...value, id: "custom", builtIn: false, settings: { ...EMPTY_SETTINGS, fontFamily: 'a"; } body { color: red; } /*' } })).toContain('font-family: "a\\"; } body { color: red; } /*"');
  });
  it("checks real authentication before all four RPC handlers and persists authenticated changes", async () => {
    for (const fn of [listKindleProfiles, createKindleProfile, updateKindleProfile, deleteKindleProfile]) await expect(invoke(fn, input())).rejects.toMatchObject({ status: 303 });
    scope.request = new Request("http://localhost/kindle", { headers: { Cookie: `bindery_session=${signIn(scope.library!.db)}` } });
    const created = await invoke(createKindleProfile, input()) as { id: string }; expect(await invoke(listKindleProfiles, "device-a")).toHaveLength(2);
    await invoke(updateKindleProfile, { ...input(), name: "RPC update", id: created.id }); expect((await invoke(listKindleProfiles, "device-a") as Array<{ name: string }>)[1].name).toBe("RPC update");
    await invoke(deleteKindleProfile, { deviceId: "device-a", id: created.id }); expect(await invoke(listKindleProfiles, "device-a")).toHaveLength(1);
  });
});
