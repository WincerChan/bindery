import type { DatabaseSync } from "node:sqlite";
import { BASE_TABLES, TABLES, INDEXES } from "./schema";
import { transaction, type Row } from "./connection";
import { wishIdentity } from "./encoding";
import { initKindleSchema } from "../kindle/migration";
import { initTypesetSchema } from "../typeset/migration";
function columns(conn: DatabaseSync, table: string): Set<string> {
  return new Set(conn.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)));
}
export function initSchema(conn: DatabaseSync): void {
  initKindleSchema(conn);
  // legacy executes CREATE TABLE IF NOT EXISTS (never rebuilds existing tables).
  for (const sql of BASE_TABLES) conn.exec(sql);
  const sessionColumns = columns(conn, "sessions");
  if (!sessionColumns.has("auth_method")) conn.exec("ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password'");
  if (!sessionColumns.has("password_verified_at")) conn.exec("ALTER TABLE sessions ADD COLUMN password_verified_at TEXT");
  for (const sql of TABLES) conn.exec(sql);
  initTypesetSchema(conn);
  const wishlistColumns = columns(conn, "wishlist");
  for (const [name, type] of [["library_book_id", "TEXT"], ["identity_title", "TEXT NOT NULL DEFAULT ''"], ["identity_author", "TEXT NOT NULL DEFAULT ''"], ["read_status", "TEXT NOT NULL DEFAULT 'unread'"], ["tags_json", "TEXT NOT NULL DEFAULT '[]'"], ["comment", "TEXT"]]) if (!wishlistColumns.has(name!)) conn.exec(`ALTER TABLE wishlist ADD COLUMN ${name} ${type}`);
  transaction(conn, () => {
    conn.exec("UPDATE wishlist SET library_book_id = NULL WHERE trim(coalesce(library_book_id, '')) = ''");
    const update = conn.prepare("UPDATE wishlist SET identity_title = ?, identity_author = ? WHERE id = ?");
    for (const row of conn.prepare("SELECT id, title, author FROM wishlist").all()) {
      update.run(...wishIdentity(row.title as string, row.author as string | null), String(row.id));
    }
    const dedupe = (sql: string, key: (row: Row) => string) => {
      const seen = new Set<string>(),
        remove = conn.prepare("DELETE FROM wishlist WHERE id = ?");
      for (const row of conn.prepare(sql).all()) {
        const identity = key(row);
        if (seen.has(identity)) remove.run(String(row.id));else seen.add(identity);
      }
    };
    dedupe("SELECT id, library_book_id FROM wishlist WHERE library_book_id IS NOT NULL AND library_book_id != '' ORDER BY updated_at DESC, created_at DESC, id DESC", r => String(r.library_book_id));
    dedupe("SELECT id, identity_title, identity_author FROM wishlist WHERE library_book_id IS NULL AND identity_title != '' ORDER BY updated_at DESC, created_at DESC, id DESC", r => JSON.stringify([r.identity_title, r.identity_author]));
    for (const sql of INDEXES) conn.exec(sql);
  });
}
