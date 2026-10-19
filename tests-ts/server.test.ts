import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { databasePath, readBookCount } from "../src/server/database";
import { readEnv } from "../src/server/env";
import { loadRuleTemplates, loadThemeTemplates } from "../src/server/templates";
const dir = mkdtempSync(resolve(tmpdir(), "bindery-server-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
describe("read-only existing SQLite library", () => {
  it("resolves Python environment precedence and paths", () => {
    expect(databasePath({}, "/tmp")).toBe(resolve("library/bindery.db"));
    expect(databasePath({ BINDERY_LIBRARY_DIR: "books" }, "/tmp")).toBe(
      "/tmp/books/bindery.db",
    );
    expect(
      databasePath(
        { BINDERY_LIBRARY_DIR: "/mnt/books", BINDERY_DB_PATH: "explicit.db" },
        "/tmp",
      ),
    ).toBe("/tmp/explicit.db");
    expect(databasePath({ BINDERY_LIBRARY_DIR: "/mnt/books" }, "/tmp")).toBe(
      "/mnt/books/bindery.db",
    );
  });
  it("supports _FILE values and strips only CR/LF like Python", () => {
    const path = resolve(dir, "db-path");
    writeFileSync(path, " relative.db \r\n");
    expect(readEnv("BINDERY_DB_PATH", { BINDERY_DB_PATH_FILE: path })).toBe(
      " relative.db ",
    );
    expect(
      readEnv("BINDERY_DB_PATH", {
        BINDERY_DB_PATH: "direct",
        BINDERY_DB_PATH_FILE: path,
      }),
    ).toBe("direct");
    expect(
      readEnv("BINDERY_DB_PATH", {
        BINDERY_DB_PATH_FILE: resolve(dir, "absent"),
      }),
    ).toBeUndefined();
  });
  it("returns zero for a missing DB without creating directories or files", () => {
    const path = resolve(dir, "missing/subdir/db.sqlite");
    expect(readBookCount(path)).toEqual({ count: 0, missing: true });
  });
  it("counts existing books and leaves every database byte unchanged", () => {
    const path = resolve(dir, "existing.db"),
      db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE books (book_id TEXT PRIMARY KEY); INSERT INTO books VALUES ('a'), ('b'), ('c')",
    );
    db.close();
    const before = readFileSync(path);
    expect(readBookCount(path)).toEqual({ count: 3, missing: false });
    expect(readFileSync(path)).toEqual(before);
    const readonly = new DatabaseSync(path, { readOnly: true });
    try {
      expect(() => readonly.exec("DELETE FROM books")).toThrow(/readonly/);
    } finally {
      readonly.close();
    }
  });
  it("surfaces a corrupt or incompatible DB instead of silently showing zero", () => {
    const path = resolve(dir, "corrupt.db");
    writeFileSync(path, "not sqlite");
    expect(() => readBookCount(path)).toThrow();
    const empty = resolve(dir, "empty.db"),
      db = new DatabaseSync(empty);
    db.close();
    expect(() => readBookCount(empty)).toThrow(/books/);
  });
});
it("loads seed templates into an isolated runtime directory", () => {
  const old = process.env.BINDERY_TEMPLATE_DIR;
  process.env.BINDERY_TEMPLATE_DIR = resolve(dir, "templates");
  try {
    expect(loadRuleTemplates()[0].rule_id).toBe("default");
    expect(loadThemeTemplates()[0].css).toContain(".chapter-title");
    writeFileSync(resolve(dir, "templates/rules/invalid.json"), "{");
    expect(loadRuleTemplates()).toHaveLength(1);
  } finally {
    if (old === undefined) delete process.env.BINDERY_TEMPLATE_DIR;
    else process.env.BINDERY_TEMPLATE_DIR = old;
  }
});
