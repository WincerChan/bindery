import type { DatabaseSync } from "node:sqlite";

/** Additive/idempotent. Activate the optional feature on first use; upgrade it at normal init
 * once activated. Libraries which have never used Kindle keep their exact legacy schema. */
export function initKindleSchema(db: DatabaseSync, activate = false) {
  if (!activate && !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kindle_profiles'").get()) return;
  db.exec(`CREATE TABLE IF NOT EXISTS kindle_profiles (
    id TEXT PRIMARY KEY, device_id TEXT NOT NULL, name TEXT NOT NULL,
    settings_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS kindle_profiles_device ON kindle_profiles(device_id)`);
}
