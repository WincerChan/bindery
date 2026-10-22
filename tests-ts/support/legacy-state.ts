import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readArchive, writeArchive } from "../../src/core/archive";

/** Raw SQLite state, independent of the storage/database API under test. */
export function databaseState(path: string): string {
  if (!existsSync(path)) return "";
  const db = new DatabaseSync(path);
  try {
    const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'device_reading' ORDER BY name").all();
    const literal = (value: unknown): string => value === null ? "NULL" : value instanceof Uint8Array ? `X'${Buffer.from(value).toString("hex")}'` : typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : String(value);
    const statements = tables.flatMap(table => [
      String(table.sql) + ";",
      ...db.prepare(`SELECT * FROM "${String(table.name)}"`).all().map(row => `INSERT INTO "${String(table.name)}" VALUES (${Object.values(row).map(literal).join(",")});`),
    ]);
    statements.push(...db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND tbl_name != 'device_reading' ORDER BY name").all().map(row => String(row.sql) + ";"));
    return statements.join("\n");
  } finally { db.close(); }
}

export interface FileState {
  [name: string]: { data: string } | { zip: { name: string; data: string }[] };
}

/** Raw library files, excluding SQLite sidecars. EPUB members are stored separately. */
export function fileState(base: string): FileState {
  if (!existsSync(base)) return {};
  const names = readdirSync(base, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name).slice(base.length + 1))
    .filter(name => !/\.(db|sqlite)(-(wal|shm))?$/.test(name));
  return Object.fromEntries(names.map(name => {
    const bytes = readFileSync(join(base, name));
    return [name, name.endsWith(".epub")
      ? { zip: readArchive(bytes).map(entry => ({ name: entry.name, data: Buffer.from(entry.data).toString("base64") })) }
      : { data: bytes.toString("base64") }];
  }));
}

export function restoreDatabase(path: string, sql: string): void {
  if (!sql) { rmSync(path, { force: true }); return; }
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=OFF; BEGIN");
    for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) db.exec(`DROP TABLE "${String(row.name)}"`);
    db.exec(sql);
    db.exec("COMMIT");
  } finally { db.close(); }
}

export function restoreFiles(base: string, files: FileState): void {
  rmSync(base, { recursive: true, force: true });
  for (const [name, file] of Object.entries(files)) {
    const path = join(base, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "zip" in file
      ? writeArchive(file.zip.map(entry => ({ name: entry.name, data: Buffer.from(entry.data, "base64") })))
      : Buffer.from(file.data, "base64"));
  }
}
