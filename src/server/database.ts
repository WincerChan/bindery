import { cpSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readEnv } from "./env";
import { libraryPath, projectRoot } from "./paths";
export function databasePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const explicit = readEnv("BINDERY_DB_PATH", env);
  if (explicit) return resolve(cwd, explicit);
  return resolve(libraryPath(env, cwd), "bindery.db");
}

// Keep path inspection read-only. Only a writable connection performs the legacy implementation's
// one-time relocation of the old repository-root database.
export function writableDatabasePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), root = projectRoot): string {
  const target = databasePath(env, cwd);
  if (!readEnv("BINDERY_DB_PATH", env)) {
    mkdirSync(dirname(target), {
      recursive: true
    });
    const legacy = resolve(root, "bindery.db");
    if (target !== legacy && !statSync(target, {
      throwIfNoEntry: false
    }) && statSync(legacy, {
      throwIfNoEntry: false
    })) {
      try {
        renameSync(legacy, target);
      } catch {
        try {
          cpSync(legacy, target, {
            preserveTimestamps: true
          });
          unlinkSync(legacy);
        } catch {/* legacy also leaves an inaccessible legacy database in place. */}
      }
    }
  }
  return target;
}
export function readBookCount(path = databasePath()): {
  count: number;
  missing: boolean;
} {
  if (!statSync(path, {
    throwIfNoEntry: false
  })) return {
    count: 0,
    missing: true
  };
  const db = new DatabaseSync(path, {
    readOnly: true
  });
  try {
    const row = db.prepare("SELECT count(*) AS count FROM books").get();
    return {
      count: Number(row?.count ?? 0),
      missing: false
    };
  } finally {
    db.close();
  }
}
