import { randomUUID } from "node:crypto";
import type { Connection } from "../db/connection";
import { HttpError } from "../http";
import { defaultProfile, DEFAULT_PROFILE_ID, deviceIdInput, profileInput, profileKeyInput, profileSettings, type TypesettingProfile } from "../../client/kindle/profiles";
import { initKindleSchema } from "./migration";

export class KindleProfiles {
  constructor(private db: Connection) { db.withConnection(conn => initKindleSchema(conn, true)); }
  list(deviceId: string): TypesettingProfile[] {
    deviceId = deviceIdInput(deviceId);
    return [defaultProfile(deviceId), ...this.db.all<{ id: string; device_id: string; name: string; settings_json: string }>("SELECT * FROM kindle_profiles WHERE device_id = ? ORDER BY created_at, id", deviceId).map(row => ({ id: row.id, deviceId: row.device_id, name: row.name, settings: profileSettings(JSON.parse(row.settings_json)), builtIn: false }))];
  }
  create(input: unknown): TypesettingProfile {
    const value = profileInput(input), id = randomUUID(), now = new Date().toISOString();
    this.db.run("INSERT INTO kindle_profiles(id, device_id, name, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", id, value.deviceId, value.name, JSON.stringify(value.settings), now, now);
    return { ...value, id, builtIn: false };
  }
  update(input: unknown): TypesettingProfile {
    const key = profileKeyInput(input), value = profileInput(input);
    if (key.id === DEFAULT_PROFILE_ID) throw new HttpError(400, "默认排版配置不可修改");
    if (!this.db.run("UPDATE kindle_profiles SET name = ?, settings_json = ?, updated_at = ? WHERE id = ? AND device_id = ?", value.name, JSON.stringify(value.settings), new Date().toISOString(), key.id, key.deviceId)) throw new HttpError(404, "排版配置不存在");
    return { ...value, id: key.id, builtIn: false };
  }
  delete(input: unknown) {
    const key = profileKeyInput(input);
    if (key.id === DEFAULT_PROFILE_ID) throw new HttpError(400, "默认排版配置不可删除");
    if (!this.db.run("DELETE FROM kindle_profiles WHERE id = ? AND device_id = ?", key.id, key.deviceId)) throw new HttpError(404, "排版配置不存在");
    return { ok: true };
  }
}
