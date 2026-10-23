import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../db/connection";
import { profileSettings } from "../../client/devices/profiles";
import { DEVICE_TYPESET } from "../../client/devices/typeset";

const KINDLE_MARGINS = new Set<string>(DEVICE_TYPESET.kindle.presets.map(preset => preset.id));
const exists = (db: DatabaseSync, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const setting = (db: DatabaseSync, key: string) => (db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value?: string } | undefined)?.value;

function migrate(db: DatabaseSync) {
  if (setting(db, "typeset_profiles_migrated")) return;
  transaction(db, () => {
    if (setting(db, "typeset_profiles_migrated")) return;
    const now = new Date().toISOString();
    const legacy = exists(db, "kindle_profiles");
    const insertProfile = db.prepare("INSERT OR IGNORE INTO typeset_profiles(id, name, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    for (const row of (legacy ? db.prepare("SELECT id, name, settings_json, created_at, updated_at FROM kindle_profiles").all() : []) as Array<Record<string, string>>) {
      try {
        insertProfile.run(row.id, row.name, JSON.stringify(profileSettings(JSON.parse(row.settings_json))), row.created_at, row.updated_at);
      } catch (error) {
        console.warn(`跳过无法迁移的排版方案 ${row.id}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const insertDevice = db.prepare("INSERT OR IGNORE INTO device_typeset(device_id, settings_json, updated_at) VALUES (?, ?, ?)");
    for (const row of (legacy ? db.prepare("SELECT DISTINCT device_id FROM kindle_profiles").all() : []) as Array<{ device_id: string }>) {
      const latest = db.prepare("SELECT settings_json FROM kindle_profiles WHERE device_id = ? ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT 1").get(row.device_id) as { settings_json?: string } | undefined;
      let margin = "narrow";
      try {
        const raw = JSON.parse(latest?.settings_json ?? "{}") as { kindleMargin?: unknown };
        if (typeof raw.kindleMargin === "string" && KINDLE_MARGINS.has(raw.kindleMargin)) margin = raw.kindleMargin;
      } catch { /* Invalid legacy JSON keeps the measured default. */ }
      insertDevice.run(row.device_id, JSON.stringify({ margin, scale: 1, lineHeight: 1.75 }), now);
    }
    db.prepare("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)").run("typeset_profiles_migrated", now);
  });
}

/** Additive/idempotent. Activate on first use; also active when the legacy Kindle table exists so its rows migrate once. */
export function initTypesetSchema(db: DatabaseSync, activate = false) {
  const legacy = exists(db, "kindle_profiles"), current = exists(db, "typeset_profiles");
  if (!activate && !legacy && !current) return;
  db.exec(`CREATE TABLE IF NOT EXISTS typeset_profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, settings_json TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS device_typeset (
    device_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL, updated_at TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  migrate(db);
}
