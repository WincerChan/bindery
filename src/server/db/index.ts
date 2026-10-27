import { randomBytes } from "node:crypto";
import type { Job, Wish } from "../../core/models";
import { strip } from "../../core/text";
import { Connection, transaction, type Row, type Value } from "./connection";
import { nowIso, compatJson, compatString, readTags, wishIdentity } from "./encoding";
import { initSchema } from "./init";
export { connect, transaction } from "./connection";
export { nowIso } from "./encoding";
export interface Session {
  session_id: string;
  created_at: string;
  last_seen: string;
  auth_method: string;
  password_verified_at: string | null;
}
export interface Passkey {
  credential_id: string;
  public_key: Uint8Array;
  sign_count: number;
  transports_json: string;
  aaguid: string | null;
  device_type: string | null;
  backed_up: number;
  name: string;
  created_at: string;
  last_used_at: string | null;
}
export interface Challenge {
  id: string;
  kind: string;
  challenge: Uint8Array;
  session_id: string | null;
  expires_at: string;
}
export interface DeviceReading {
  book_id: string;
  device_id: string;
  device_kind: string;
  device_name: string;
  section: number | null;
  section_fraction: number | null;
  percent: number | null;
  location: string | null;
  read_status: string;
  last_read_at: string | null;
  time_spent_seconds: number;
  rest_estimate_seconds: number | null;
  synced_at: string;
}
export interface VocabularyRow {
  id: string;
  device_id: string;
  device_kind: string;
  device_name: string;
  word: string;
  raw_word: string;
  lang: string | null;
  book_id: string | null;
  source_title: string;
  looked_up_at: string;
  device_context_json: string | null;
  context_json: string | null;
  context_state: string;
  push_state: string;
  push_status_json: string | null;
  pushed_at: string | null;
  created_at: string;
  updated_at: string;
}
const VOCABULARY_COLUMNS = ["id", "device_id", "device_kind", "device_name", "word", "raw_word", "lang", "book_id", "source_title", "looked_up_at", "device_context_json", "context_json", "context_state", "push_state", "push_status_json", "pushed_at", "created_at", "updated_at"] as const;
export interface VocabularyFilter { deviceId?: string; bookId?: string; pushState?: string; query?: string; limit?: number }
const DEVICE_READING_COLUMNS = ["book_id", "device_id", "device_kind", "device_name", "section", "section_fraction", "percent", "location", "read_status", "last_read_at", "time_spent_seconds", "rest_estimate_seconds", "synced_at"] as const;
function rowToWish(row: Row): Wish {
  let readStatus = row.read_status ? strip(String(row.read_status)).toLowerCase() : "unread";
  if (!["unread", "reading", "read"].includes(readStatus)) readStatus = row.read ? "read" : "unread";
  return {
    id: row.id as string,
    title: (row.title || "") as string,
    library_book_id: (row.library_book_id ?? null) as string | null,
    author: row.author as string | null,
    rating: row.rating as number | null,
    read: Boolean(row.read),
    read_status: readStatus,
    tags: readTags(row.tags_json),
    comment: (row.comment ?? null) as string | null,
    book_status: (row.book_status || "ongoing") as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string
  };
}
const JOB_COLUMNS = ["id", "book_id", "action", "status", "stage", "message", "log", "rule_template", "created_at", "updated_at"];
const WISH_COLUMNS = ["id", "title", "library_book_id", "author", "identity_title", "identity_author", "rating", "read", "read_status", "tags_json", "comment", "book_status", "created_at", "updated_at"];
export class BinderyDatabase extends Connection {
  init(): void {
    this.withConnection(initSchema);
  }
  createSession(id: string, createdAt: string, method = "password", verifiedAt: string | null = null): void {
    this.run("INSERT INTO sessions(session_id, created_at, last_seen, auth_method, password_verified_at) VALUES (?, ?, ?, ?, ?)", id, createdAt, createdAt, method, verifiedAt);
  }
  getSession(id: string): Session | null {
    return this.get("SELECT * FROM sessions WHERE session_id = ?", id);
  }
  touchSession(id: string, now: string): void {
    this.run("UPDATE sessions SET last_seen = ? WHERE session_id = ?", now, id);
  }
  deleteSession(id: string): void {
    this.run("DELETE FROM sessions WHERE session_id = ?", id);
  }
  markPasswordVerified(id: string, now: string): void {
    this.run("UPDATE sessions SET password_verified_at = ?, auth_method = 'password' WHERE session_id = ?", now, id);
  }
  // The legacy column is the last step-up verification timestamp. A passkey
  // does not rewrite the login method; only a password step-up does, so
  // zero-key first enrollment can always require the password.
  markReauthenticated(id: string, now: string): void {
    this.run("UPDATE sessions SET password_verified_at = ? WHERE session_id = ?", now, id);
  }
  clearReauthentication(): void {
    this.run("UPDATE sessions SET password_verified_at = NULL");
  }
  createJob(job: Job): void {
    this.run(`INSERT INTO jobs(${JOB_COLUMNS.join(", ")}) VALUES (${JOB_COLUMNS.map(() => "?").join(", ")})`, ...JOB_COLUMNS.map(c => job[c as keyof Job]));
  }
  updateJob(id: string, fields: Partial<Job>): void {
    this.update("jobs", "id", id, fields, JOB_COLUMNS);
  }
  getJob(id: string): Job | null {
    return this.get("SELECT * FROM jobs WHERE id = ?", id);
  }
  listJobs(status?: string): Job[] {
    return status ? this.all("SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC", status) : this.all("SELECT * FROM jobs ORDER BY created_at DESC");
  }
  deleteJobs(ids: string[]): number {
    return ids.length ? this.run(`DELETE FROM jobs WHERE id IN (${ids.map(() => "?").join(", ")})`, ...ids) : 0;
  }
  upsertReaderProgress(bookId: string, section: number, page: number, pageCount: number, updatedAt: string): void {
    this.run(`INSERT INTO reader_progress(book_id, section, page, page_count, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(book_id) DO UPDATE SET section=excluded.section, page=excluded.page, page_count=excluded.page_count, updated_at=excluded.updated_at`, bookId, section, page, pageCount, updatedAt);
  }
  getReaderProgress(bookId: string): {
    book_id: string;
    section: number;
    page: number;
    page_count: number;
    updated_at: string;
  } | null {
    return this.get("SELECT book_id, section, page, page_count, updated_at FROM reader_progress WHERE book_id = ?", bookId);
  }
  upsertDeviceReading(row: DeviceReading): void {
    this.run(`INSERT INTO device_reading(${DEVICE_READING_COLUMNS.join(", ")}) VALUES (${DEVICE_READING_COLUMNS.map(() => "?").join(", ")})
      ON CONFLICT(book_id, device_id) DO UPDATE SET ${DEVICE_READING_COLUMNS.slice(2).map(column => `${column}=excluded.${column}`).join(", ")}`, ...DEVICE_READING_COLUMNS.map(column => row[column]));
  }
  listDeviceReading(bookId: string): DeviceReading[] {
    return this.all("SELECT * FROM device_reading WHERE book_id = ? ORDER BY last_read_at DESC, device_id", bookId);
  }
  listDeviceReadingForDevice(deviceId: string): DeviceReading[] {
    return this.all("SELECT * FROM device_reading WHERE device_id = ? ORDER BY book_id", deviceId);
  }
  upsertVocabulary(row: VocabularyRow): void {
    this.run(`INSERT INTO vocabulary(${VOCABULARY_COLUMNS.join(", ")}) VALUES (${VOCABULARY_COLUMNS.map(() => "?").join(", ")})
      ON CONFLICT(id) DO UPDATE SET
        device_id=excluded.device_id, device_kind=excluded.device_kind, device_name=excluded.device_name,
        word=excluded.word, raw_word=excluded.raw_word, lang=excluded.lang, book_id=excluded.book_id,
        source_title=excluded.source_title, looked_up_at=excluded.looked_up_at,
        device_context_json=excluded.device_context_json,
        context_json=CASE WHEN vocabulary.context_json IS NOT NULL THEN vocabulary.context_json ELSE excluded.context_json END,
        context_state=CASE WHEN vocabulary.context_json IS NOT NULL THEN vocabulary.context_state ELSE excluded.context_state END,
        updated_at=excluded.updated_at`, ...VOCABULARY_COLUMNS.map(column => row[column]));
  }
  getVocabulary(id: string): VocabularyRow | null {
    return this.get<VocabularyRow>("SELECT * FROM vocabulary WHERE id = ?", id);
  }
  listVocabulary(filter: VocabularyFilter = {}): VocabularyRow[] {
    const conditions: string[] = [], values: Value[] = [];
    if (filter.deviceId) { conditions.push("device_id = ?"); values.push(filter.deviceId); }
    if (filter.bookId) { conditions.push("book_id = ?"); values.push(filter.bookId); }
    if (filter.pushState) { conditions.push("push_state = ?"); values.push(filter.pushState); }
    if (filter.query) { conditions.push("(lower(word) LIKE ? OR lower(source_title) LIKE ? OR lower(device_name) LIKE ?)"); const query = `%${filter.query.toLowerCase()}%`; values.push(query, query, query); }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "", limit = Math.max(1, Math.min(50000, Math.trunc(filter.limit ?? 50000)));
    return this.all<VocabularyRow>(`SELECT * FROM vocabulary${where} ORDER BY looked_up_at DESC, id LIMIT ?`, ...values, limit);
  }
  vocabularyCounts(): { total: number; pushed: number; failed: number; pending: number } {
    // Conflicts and retryable/permanent errors are failures. Unknown states use
    // the list view's pending fallback; pushed includes queued/deleted outcomes.
    return this.get<{ total: number; pushed: number; failed: number; pending: number }>(`SELECT COUNT(*) AS total,
      COUNT(CASE WHEN push_state = 'pushed' THEN 1 END) AS pushed,
      COUNT(CASE WHEN push_state IN ('error', 'conflict') THEN 1 END) AS failed,
      COUNT(CASE WHEN push_state NOT IN ('pushed', 'error', 'conflict') THEN 1 END) AS pending
      FROM vocabulary`)!;
  }
  vocabularyMonth(since: string): { count: number; top_source: { title: string; book_id: string | null; count: number } | null } {
    // Kindle's epoch milliseconds and Kobo's date strings both pass through
    // toISOString() in their readers AND vocabularyInput before being stored.
    // Comparing that canonical UTC format preserves milliseconds and uses the index.
    const count = this.get<{ count: number }>("SELECT COUNT(*) AS count FROM vocabulary WHERE looked_up_at >= ?", since)!.count;
    // Match the list's book_key: a linked book ID, otherwise title:<source>.
    // SQLite's single MAX selects the bare source_title from a latest lookup;
    // the service resolves its display title using the list's shared cache.
    const top_source = this.get<{ title: string; book_id: string | null; count: number }>(`SELECT source_title AS title, book_id, COUNT(*) AS count
      FROM vocabulary WHERE looked_up_at >= ? GROUP BY COALESCE(book_id, 'title:' || source_title)
      ORDER BY count DESC, MAX(looked_up_at) DESC, source_title, book_id LIMIT 1`, since);
    return { count, top_source };
  }
  latestVocabulary(): VocabularyRow | null {
    return this.get<VocabularyRow>("SELECT * FROM vocabulary ORDER BY looked_up_at DESC, id LIMIT 1");
  }
  listVocabularyForBookDevice(bookId: string, deviceId: string): VocabularyRow[] {
    return this.all<VocabularyRow>("SELECT * FROM vocabulary WHERE book_id = ? AND device_id = ? ORDER BY looked_up_at, id", bookId, deviceId);
  }
  listVocabularyForPush(): VocabularyRow[] {
    return this.all<VocabularyRow>("SELECT * FROM vocabulary WHERE push_state IN ('pending', 'error') ORDER BY looked_up_at, id");
  }
  updateVocabularyContext(id: string, contextJson: string, contextState: string, updatedAt: string): void {
    this.run("UPDATE vocabulary SET context_json = ?, context_state = ?, updated_at = ? WHERE id = ?", contextJson, contextState, updatedAt, id);
  }
  updateVocabularyPush(id: string, pushState: string, pushStatusJson: string | null, pushedAt: string | null, updatedAt: string): void {
    this.run("UPDATE vocabulary SET push_state = ?, push_status_json = ?, pushed_at = ?, updated_at = ? WHERE id = ?", pushState, pushStatusJson, pushedAt, updatedAt, id);
  }
  resetVocabularyPush(ids?: string[]): number {
    if (ids && !ids.length) return 0;
    return ids ? this.run(`UPDATE vocabulary SET push_state = 'pending', push_status_json = NULL, pushed_at = NULL WHERE id IN (${ids.map(() => "?").join(", ")})`, ...ids)
      : this.run("UPDATE vocabulary SET push_state = 'pending', push_status_json = NULL, pushed_at = NULL WHERE push_state IN ('error', 'conflict')");
  }
  createWish(wish: Wish): void {
    const identity = wishIdentity(wish.title, wish.author);
    this.run(`INSERT INTO wishlist(${WISH_COLUMNS.join(", ")}) VALUES (${WISH_COLUMNS.map(() => "?").join(", ")})`, wish.id, wish.title, strip(wish.library_book_id || "").toLowerCase() || null, wish.author, ...identity, wish.rating, Number(Boolean(wish.read)), wish.read_status, compatJson(wish.tags), wish.comment, wish.book_status, wish.created_at, wish.updated_at);
  }
  private wish(sql: string, ...params: Value[]): Wish | null {
    const row = this.get(sql, ...params);
    return row ? rowToWish(row) : null;
  }
  getWish(id: string): Wish | null {
    return this.wish("SELECT * FROM wishlist WHERE id = ?", id);
  }
  getWishByLibraryBookId(id: string): Wish | null {
    return this.wish("SELECT * FROM wishlist WHERE library_book_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1", id);
  }
  getManualWishByIdentity(title: string, author: string | null, excludeId?: string): Wish | null {
    const identity = wishIdentity(title, author);
    if (!identity[0]) return null;
    const exclude = strip(excludeId || "");
    return this.wish(`SELECT * FROM wishlist WHERE library_book_id IS NULL AND identity_title = ? AND identity_author = ? ${exclude ? "AND id != ?" : ""} ORDER BY updated_at DESC, created_at DESC LIMIT 1`, ...identity, ...(exclude ? [exclude] : []));
  }
  listWishes(): Wish[] {
    return this.all("SELECT * FROM wishlist ORDER BY updated_at DESC, created_at DESC").map(rowToWish);
  }
  updateWish(id: string, input: Partial<Wish> & {
    tags?: unknown;
  }): void {
    const fields: Record<string, unknown> = {
      ...input
    };
    if ("tags" in fields) {
      fields.tags_json = compatJson(Array.isArray(fields.tags) ? fields.tags.map(compatString).filter(s => strip(s)) : []);
      delete fields.tags;
    }
    if ("read" in fields) fields.read = Number(Boolean(fields.read));
    if ("library_book_id" in fields) fields.library_book_id = typeof fields.library_book_id === "string" ? strip(fields.library_book_id).toLowerCase() || null : null;
    if ("title" in fields || "author" in fields) {
      const current = this.getWish(id);
      [fields.identity_title, fields.identity_author] = wishIdentity(("title" in fields ? fields.title : current?.title || "") as string, ("author" in fields ? fields.author : current?.author || null) as string | null);
    }
    if ("read_status" in fields && !("read" in fields)) fields.read = Number(strip(String(fields.read_status)).toLowerCase() === "read");
    this.update("wishlist", "id", id, fields, WISH_COLUMNS);
  }
  deleteWish(id: string): void {
    this.run("DELETE FROM wishlist WHERE id = ?", id);
  }
  listPasskeys(): Passkey[] {
    return this.all("SELECT * FROM passkeys ORDER BY created_at, credential_id");
  }
  getPasskey(id: string): Passkey | null {
    return this.get("SELECT * FROM passkeys WHERE credential_id = ?", id);
  }
  countPasskeys(): number {
    return this.get<{
      n: number;
    }>("SELECT count(*) AS n FROM passkeys")!.n;
  }
  passkeySummary(): { passkey_count: number; last_used_at: string | null } {
    return this.get<{ passkey_count: number; last_used_at: string | null }>(
      "SELECT COUNT(*) AS passkey_count, MAX(last_used_at) AS last_used_at FROM passkeys",
    )!;
  }
  insertPasskey(key: Omit<Passkey, "last_used_at" | "backed_up"> & {
    backed_up: boolean | number;
  }): void {
    this.run(`INSERT INTO passkeys (credential_id, public_key, sign_count, transports_json, aaguid, device_type, backed_up, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, key.credential_id, key.public_key, key.sign_count, key.transports_json, key.aaguid, key.device_type, Number(key.backed_up), key.name, key.created_at);
  }
  updatePasskeyUsage(id: string, signCount: number, backedUp: boolean, now: string): void {
    this.run("UPDATE passkeys SET sign_count = ?, backed_up = ?, last_used_at = ? WHERE credential_id = ?", signCount, Number(backedUp), now, id);
  }
  renamePasskey(id: string, name: string): boolean {
    return this.run("UPDATE passkeys SET name = ? WHERE credential_id = ?", name, id) > 0;
  }
  deletePasskey(id: string): boolean {
    return this.run("DELETE FROM passkeys WHERE credential_id = ?", id) > 0;
  }
  getSetting(key: string): string | null {
    return this.get<{
      value: string;
    }>("SELECT value FROM app_settings WHERE key = ?", key)?.value ?? null;
  }
  setSetting(key: string, value: string): void {
    this.run("INSERT INTO app_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value);
  }
  getOrCreateWebauthnUserId(): Uint8Array<ArrayBuffer> {
    const value = this.withConnection(conn => transaction(conn, () => {
      conn.prepare("INSERT OR IGNORE INTO app_settings(key, value) VALUES ('webauthn_user_id', ?)").run(randomBytes(32).toString("base64url"));
      return conn.prepare("SELECT value FROM app_settings WHERE key = 'webauthn_user_id'").get()!.value as string;
    }));
    return new Uint8Array(Buffer.from(value, "base64url"));
  }
  createChallenge(kind: "login" | "register" | "reauth", challenge: Uint8Array, sessionId: string | null = null, date = new Date()): string {
    if (!["login", "register", "reauth"].includes(kind) || kind !== "login" && !sessionId) throw new Error("Invalid challenge kind or missing session");
    const id = randomBytes(32).toString("base64url");
    this.withConnection(conn => transaction(conn, () => {
      conn.prepare("DELETE FROM webauthn_challenges WHERE expires_at <= ?").run(nowIso(date));
      conn.prepare("INSERT INTO webauthn_challenges VALUES (?, ?, ?, ?, ?)").run(id, kind, challenge, sessionId, nowIso(new Date(date.getTime() + 300000)));
    }));
    return id;
  }
  popChallenge(id: string): Challenge | null {
    return this.get("DELETE FROM webauthn_challenges WHERE id = ? RETURNING *", id);
  }
}
