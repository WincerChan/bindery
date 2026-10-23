import { randomUUID } from "node:crypto";
import type { Connection } from "../db/connection";
import { HttpError } from "../http";
import { defaultProfile, DEFAULT_PROFILE_ID, deviceIdInput, profileInput, profileKeyInput, profileSettings, type TypesettingProfile } from "../../client/devices/profiles";
import { defaultReadingSettings, readingSettings, type DeviceReadingSettings } from "../../client/devices/typeset";
import type { DeviceKind } from "../../client/devices/models";
import { initTypesetSchema } from "./migration";

function kindInput(value: unknown): DeviceKind {
  if (value !== "kindle" && value !== "kobo") throw new Error("无效的设备类型");
  return value;
}
export function deviceTypesetInput(value: unknown) {
  const v = value as Record<string, unknown> | null;
  if (!v) throw new Error("无效的设备阅读设置");
  return { deviceId: deviceIdInput(v.deviceId), kind: kindInput(v.kind), settings: readingSettings(kindInput(v.kind), v.settings) };
}

export class TypesetProfiles {
  constructor(private db: Connection) { db.withConnection(conn => initTypesetSchema(conn, true)); }
  list(): TypesettingProfile[] {
    return [defaultProfile(), ...this.db.all<{ id: string; name: string; settings_json: string }>("SELECT * FROM typeset_profiles ORDER BY created_at, id").map(row => ({ id: row.id, name: row.name, settings: profileSettings(JSON.parse(row.settings_json)), builtIn: false }))];
  }
  create(input: unknown): TypesettingProfile {
    const value = profileInput(input), id = randomUUID(), now = new Date().toISOString();
    this.db.run("INSERT INTO typeset_profiles(id, name, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", id, value.name, JSON.stringify(value.settings), now, now);
    return { ...value, id, builtIn: false };
  }
  update(input: unknown): TypesettingProfile {
    const key = profileKeyInput(input), value = profileInput(input);
    if (key.id === DEFAULT_PROFILE_ID) throw new HttpError(400, "默认排版方案不可修改");
    if (!this.db.run("UPDATE typeset_profiles SET name = ?, settings_json = ?, updated_at = ? WHERE id = ?", value.name, JSON.stringify(value.settings), new Date().toISOString(), key.id)) throw new HttpError(404, "排版方案不存在");
    return { ...value, id: key.id, builtIn: false };
  }
  delete(input: unknown) {
    const key = profileKeyInput(input);
    if (key.id === DEFAULT_PROFILE_ID) throw new HttpError(400, "默认排版方案不可删除");
    if (!this.db.run("DELETE FROM typeset_profiles WHERE id = ?", key.id)) throw new HttpError(404, "排版方案不存在");
    return { ok: true };
  }
}

export class DeviceTypeset {
  constructor(private db: Connection) { db.withConnection(conn => initTypesetSchema(conn, true)); }
  get(deviceId: string, kind: DeviceKind): DeviceReadingSettings {
    const id = deviceIdInput(deviceId), key = kindInput(kind);
    const row = this.db.get<{ settings_json: string }>("SELECT settings_json FROM device_typeset WHERE device_id = ?", id);
    if (!row) return defaultReadingSettings(key);
    try { return readingSettings(key, JSON.parse(row.settings_json)); } catch { return defaultReadingSettings(key); }
  }
  save(input: unknown): DeviceReadingSettings {
    const value = deviceTypesetInput(input), now = new Date().toISOString();
    this.db.run("INSERT INTO device_typeset(device_id, settings_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at", value.deviceId, JSON.stringify(value.settings), now);
    return value.settings;
  }
}
