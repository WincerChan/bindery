import { randomBytes } from "node:crypto";
import type { Job, Wish } from "../../core/models";
import { strip } from "../../core/python";
import { Connection, transaction, type Row, type Value } from "./connection";
import { nowIso, pythonJson, pythonString, readTags, wishIdentity } from "./encoding";
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
    this.run("UPDATE sessions SET password_verified_at = ? WHERE session_id = ?", now, id);
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
  createWish(wish: Wish): void {
    const identity = wishIdentity(wish.title, wish.author);
    this.run(`INSERT INTO wishlist(${WISH_COLUMNS.join(", ")}) VALUES (${WISH_COLUMNS.map(() => "?").join(", ")})`, wish.id, wish.title, strip(wish.library_book_id || "").toLowerCase() || null, wish.author, ...identity, wish.rating, Number(Boolean(wish.read)), wish.read_status, pythonJson(wish.tags), wish.comment, wish.book_status, wish.created_at, wish.updated_at);
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
      fields.tags_json = pythonJson(Array.isArray(fields.tags) ? fields.tags.map(pythonString).filter(s => strip(s)) : []);
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
  createChallenge(kind: "login" | "register", challenge: Uint8Array, sessionId: string | null = null, date = new Date()): string {
    if (!["login", "register"].includes(kind) || kind === "register" && !sessionId) throw new Error("Invalid challenge kind or missing registration session");
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
