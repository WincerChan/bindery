import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BinderyDatabase, connect } from "../src/server/db";
import { TypesetProfiles, DeviceTypeset } from "../src/server/typeset/profiles";
import { generateProfileCss, profileSettings } from "../src/client/devices/profiles";

const root = mkdtempSync(join(tmpdir(), "bindery-typeset-migration-")); let sequence = 0;
beforeEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(root, { recursive: true, force: true }));
const id = "d0d0b93a-d39c-4435-894a-c34fe259796a", deviceId = "da44e2ee-f896-465a-ab5a-74f47fac1cef", settings = '{"deviceModel":"KPW3","kindleMargin":"narrow","marginX":-4.9,"marginXUnit":"percent","marginY":null,"lineHeight":null,"paragraphSpacing":null,"textIndent":null,"justify":null,"fontFamily":null,"customCss":"","stripFonts":false,"stripImages":true}';
function legacyDatabase(row = { id, name: "我的排版", settings_json: settings, created_at: "2026-10-20T05:05:50.443Z", updated_at: "2026-10-20T09:14:19.124Z" }, extraRows: Array<Record<string, string>> = []) {
  const dir = join(root, String(sequence++)), path = join(dir, "data.db");
  const conn = connect(path);
  conn.exec("CREATE TABLE kindle_profiles (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, name TEXT NOT NULL, settings_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE INDEX kindle_profiles_device ON kindle_profiles(device_id)");
  const insert = conn.prepare("INSERT INTO kindle_profiles(id, device_id, name, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const value of [row, ...extraRows]) insert.run(value.id, deviceId, value.name, value.settings_json, value.created_at, value.updated_at);
  conn.close();
  const db = new BinderyDatabase(path); db.init();
  return { db, path };
}
const raw = (db: BinderyDatabase) => db.all("SELECT * FROM kindle_profiles ORDER BY id");

describe("typeset storage migration", () => {
  it("copies the owner's legacy profile unchanged by id/name and byte-identical CSS", () => {
    const { db } = legacyDatabase(), before = raw(db);
    const rows = db.all<{ id: string; name: string; settings_json: string; created_at: string; updated_at: string }>("SELECT * FROM typeset_profiles");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, name: "我的排版", created_at: "2026-10-20T05:05:50.443Z", updated_at: "2026-10-20T09:14:19.124Z" });
    const parsed = JSON.parse(rows[0]!.settings_json);
    expect(parsed).toEqual(profileSettings(JSON.parse(settings)));
    expect(parsed).not.toHaveProperty("deviceModel"); expect(parsed).not.toHaveProperty("kindleMargin");
    expect(profileSettings(parsed).marginXUnit).toBe("percent");
    expect(generateProfileCss({ id, name: "我的排版", builtIn: false, settings: profileSettings(parsed) })).toBe("body > * {\n  margin-left: -4.9% !important;\n  margin-right: -4.9% !important;\n}");
    expect(db.get("SELECT value FROM app_settings WHERE key = 'typeset_profiles_migrated'")).toMatchObject({ value: expect.any(String) });
    expect(JSON.parse(db.get<{ settings_json: string }>("SELECT settings_json FROM device_typeset WHERE device_id = ?", deviceId)!.settings_json)).toEqual({ margin: "narrow" });
    expect(raw(db)).toEqual(before);
  });
  it("does not re-copy a profile deleted after migration", () => {
    const { db } = legacyDatabase(), profiles = new TypesetProfiles(db);
    profiles.delete({ id }); expect(profiles.list().map(profile => profile.id)).toEqual(["default"]);
    db.init();
    expect(profiles.list().map(profile => profile.id)).toEqual(["default"]);
    expect(raw(db)).toHaveLength(1);
  });
  it("keeps legacy em units and their CSS while using the most recently updated device margin preset", () => {
    const em = { id: "em-profile", name: "旧 em", settings_json: '{"deviceModel":"KO3","kindleMargin":"wide","marginX":-0.8}', created_at: "2026-10-19T00:00:00.000Z", updated_at: "2026-10-19T00:00:00.000Z" };
    const { db } = legacyDatabase(undefined, [em]);
    const profile = new TypesetProfiles(db).list().find(value => value.id === "em-profile")!;
    expect(profile.settings.marginXUnit).toBe("em");
    expect(generateProfileCss(profile)).toBe("body > * {\n  margin-left: -0.8em !important;\n  margin-right: -0.8em !important;\n}");
    expect(JSON.parse(db.get<{ settings_json: string }>("SELECT settings_json FROM device_typeset WHERE device_id = ?", deviceId)!.settings_json)).toEqual({ margin: "narrow" });
  });
  it("skips an invalid row with one warning while copying the valid ones", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const invalid = { id: "broken", name: "坏", settings_json: "{not json", created_at: "2026-10-19T00:00:00.000Z", updated_at: "2026-10-19T00:00:00.000Z" };
    const { db } = legacyDatabase(undefined, [invalid]);
    expect(db.all("SELECT id FROM typeset_profiles ORDER BY id").map(row => (row as { id: string }).id)).toEqual([id]);
    expect(warn).toHaveBeenCalledTimes(1); expect(warn.mock.calls[0]![0]).toContain("broken");
  });
  it("leaves a library without either table untouched until first use", () => {
    const dir = join(root, String(sequence++)), db = new BinderyDatabase(join(dir, "data.db")); db.init();
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'typeset_profiles'")).toBeNull();
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'device_typeset'")).toBeNull();
    expect(db.get("SELECT value FROM app_settings WHERE key = 'typeset_profiles_migrated'")).toBeNull();
    expect(new TypesetProfiles(db).list().map(profile => profile.id)).toEqual(["default"]);
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'typeset_profiles'")).not.toBeNull();
  });
});

describe("device reading settings", () => {
  it("stores per device, validates values and defaults by kind", () => {
    const { db } = legacyDatabase(), settings = new DeviceTypeset(db);
    expect(settings.get("other-device", "kobo")).toEqual({ margin: "min" });
    expect(settings.save({ deviceId: "other-device", kind: "kobo", settings: { margin: "bogus", scale: 9 } })).toEqual({ margin: "min" });
    expect(settings.save({ deviceId: "kindle-device", kind: "kindle", settings: { margin: "wide" } })).toEqual({ margin: "wide" });
    expect(settings.get("kindle-device", "kindle")).toEqual({ margin: "wide" });
  });
});
