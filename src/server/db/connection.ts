import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { writableDatabasePath } from "../database";
export type Row = Record<string, unknown>;
export type Value = SQLInputValue;
export function connect(path = writableDatabasePath()): DatabaseSync {
  mkdirSync(dirname(path), {
    recursive: true
  });
  // sqlite3.connect() defaults in legacy. In particular, do not enable WAL or
  // Node's default foreign-key enforcement, and preserve double-quoted literals.
  return new DatabaseSync(path, {
    enableForeignKeyConstraints: false,
    enableDoubleQuotedStringLiterals: true,
    timeout: 5000,
    defensive: false
  });
}
export function transaction<T>(conn: DatabaseSync, fn: () => T, mode: "deferred" | "immediate" = "deferred"): T {
  conn.exec(mode === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const result = fn();
    conn.exec("COMMIT");
    return result;
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  }
}
export class Connection {
  private closed = false;
  constructor(readonly path = writableDatabasePath()) {}
  // Handles are synchronous and scoped to withConnection's finally block.
  // Closing the owner prevents stale references from reopening the database.
  close(): void { this.closed = true; }
  withConnection<T>(fn: (conn: DatabaseSync) => T): T {
    if (this.closed) throw new Error("Database is closed");
    const conn = connect(this.path);
    try {
      return fn(conn);
    } finally {
      conn.close();
    }
  }
  all<T = Row>(sql: string, ...values: Value[]): T[] {
    return this.withConnection(conn => conn.prepare(sql).all(...values) as T[]);
  }
  get<T = Row>(sql: string, ...values: Value[]): T | null {
    return this.withConnection(conn => conn.prepare(sql).get(...values) as T | undefined ?? null);
  }
  run(sql: string, ...values: Value[]): number {
    return this.withConnection(conn => Number(conn.prepare(sql).run(...values).changes));
  }
  update(table: string, idColumn: string, id: string, fields: Record<string, unknown>, allowed: readonly string[]): void {
    const entries = Object.entries(fields);
    if (!entries.length) return;
    for (const [key] of entries) if (!allowed.includes(key)) throw new Error(`Invalid ${table} column: ${key}`);
    this.run(`UPDATE ${table} SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE ${idColumn} = ?`, ...entries.map(([, value]) => value as Value), id);
  }
}
