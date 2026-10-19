import { statSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readEnv } from "./env";
import { projectRoot } from "./paths";
export function databasePath(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const explicit = readEnv("BINDERY_DB_PATH", env);
  if (explicit) return resolve(cwd, explicit);
  const library = readEnv("BINDERY_LIBRARY_DIR", env);
  return resolve(
    library ? resolve(cwd, library) : resolve(projectRoot, "library"),
    "bindery.db",
  );
}
export function readBookCount(path = databasePath()): {
  count: number;
  missing: boolean;
} {
  if (!statSync(path, { throwIfNoEntry: false }))
    return { count: 0, missing: true };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT count(*) AS count FROM books").get();
    return { count: Number(row?.count ?? 0), missing: false };
  } finally {
    db.close();
  }
}
