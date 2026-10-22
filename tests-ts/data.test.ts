import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BinderyDatabase, connect } from "../src/server/db";
import { LibraryStorage, bookDir, loadBook, saveBook, saveCoverBytes, writeSourceFile } from "../src/server/storage";
import { bookFromDict, bookToDict, metadataFromDict, type Job, type Wish } from "../src/core/models";
import { writableDatabasePath } from "../src/server/database";
import { databaseState, fileState, restoreDatabase, restoreFiles, type FileState } from "./support/legacy-state";
const root = mkdtempSync(join(tmpdir(), "bindery-data-"));
afterAll(() => rmSync(root, {
  recursive: true,
  force: true
}));
const reference = (name: string) => JSON.parse(readFileSync(resolve("tests-ts/fixtures/parity/data", `${name}.json`), "utf8"));
interface RecordedState { sql: string; files: FileState }
interface RecordedStep { mode: string; input: unknown; before: RecordedState; after: RecordedState; value: unknown }
const alternatingReplay = reference("alternating-replay") as { steps: RecordedStep[] };
function replayState(path: string, step: RecordedStep, input?: unknown): unknown {
  if (input !== undefined) expect(step.input).toEqual(input);
  expect({ sql: databaseState(join(path, "data.db")), files: fileState(join(path, "library")) }).toEqual(step.before);
  restoreDatabase(join(path, "data.db"), step.after.sql);
  restoreFiles(join(path, "library"), step.after.files);
  return step.value;
}
function fixture(name: string) {
  const path = join(root, name);
  mkdirSync(path, {
    recursive: true
  });
  return {
    path,
    db: new BinderyDatabase(join(path, "data.db")),
    lib: new LibraryStorage(join(path, "library"), new BinderyDatabase(join(path, "data.db")))
  };
}
function snapshot(db: BinderyDatabase, base: string) {
  // Frozen fixtures describe the legacy image's schema; reading-sync adds tables on top.
  const schema = db.all("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").filter(row => String(row.tbl_name) !== "device_reading");
  const tables = Object.fromEntries(["books", "jobs", "sessions", "passkeys", "webauthn_challenges", "app_settings", "reader_progress", "wishlist"].map(t => [t,
    db.all(`SELECT * FROM ${t} ORDER BY 1`).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
      value instanceof Uint8Array ? { blob: Buffer.from(value).toString("hex") } : value,
    ]))),
  ]));
  const pragmas = Object.fromEntries(["foreign_keys", "busy_timeout", "journal_mode", "synchronous", "trusted_schema", "recursive_triggers", "locking_mode"].map(p => [p, Object.values(db.get(`PRAGMA ${p}`)!)[0]]));
  const files: Record<string, string> = {};
  if (existsSync(base)) for (const name of readdirSync(base, {
    recursive: true,
    withFileTypes: true
  })) {
    if (name.isFile()) {
      const file = join(name.parentPath, name.name);
      files[file.slice(base.length + 1)] = readFileSync(file).toString("hex");
    }
  }
  return {
    schema,
    tables,
    pragmas,
    files
  };
}
interface Step {
  op: string;
  args?: unknown[];
  kwargs?: Record<string, unknown>;
}
function runSteps(db: BinderyDatabase, lib: LibraryStorage, steps: Step[]): unknown[] {
  return steps.map(({
    op,
    args = [],
    kwargs = {}
  }) => {
    const [a, b, c, d, e] = args;
    switch (op) {
      case "save_metadata":
        lib.saveMetadata(metadataFromDict(a as object));
        break;
      case "save_book":
        saveBook(bookFromDict(a as object), lib.base, b as string);
        break;
      case "load_book":
        return bookToDict(loadBook(lib.base, a as string));
      case "load_metadata":
        return lib.loadMetadata(a as string);
      case "list_books":
        return lib.listBooks(kwargs.sort_output as boolean | undefined);
      case "list_books_page":
        return lib.listBooksPage(kwargs);
      case "list_archived_books":
        return lib.listArchivedBooks();
      case "archive_book":
        lib.archiveBook(a as string);
        break;
      case "restore_book":
        lib.restoreBook(a as string, b as string);
        break;
      case "delete_book":
        lib.deleteBook(a as string);
        break;
      case "ensure_book_exists":
        return lib.ensureBookExists(a as string);
      case "create_job":
        db.createJob(a as Job);
        break;
      case "get_job":
        return db.getJob(a as string);
      case "list_jobs":
        return db.listJobs(a as string);
      case "update_job":
        db.updateJob(a as string, kwargs);
        break;
      case "delete_jobs":
        return db.deleteJobs(a as string[]);
      case "create_session":
        db.createSession(a as string, b as string, c as string, d as string);
        break;
      case "get_session":
        return db.getSession(a as string);
      case "touch_session":
        db.touchSession(a as string, b as string);
        break;
      case "delete_session":
        db.deleteSession(a as string);
        break;
      case "mark_password_verified":
        db.markPasswordVerified(a as string, b as string);
        break;
      case "upsert_reader_progress":
        db.upsertReaderProgress(a as string, b as number, c as number, d as number, e as string);
        break;
      case "get_reader_progress":
        return db.getReaderProgress(a as string);
      case "create_wish":
        db.createWish(a as Wish);
        break;
      case "get_wish":
        return db.getWish(a as string);
      case "list_wishes":
        return db.listWishes();
      case "get_wish_by_library_book_id":
        return db.getWishByLibraryBookId(a as string);
      case "get_manual_wish_by_identity":
        return db.getManualWishByIdentity(a as string, b as string | null, kwargs.exclude_id as string | undefined);
      case "update_wish":
        db.updateWish(a as string, kwargs);
        break;
      case "delete_wish":
        db.deleteWish(a as string);
        break;
      case "sql":
        db.withConnection(conn => conn.exec(a as string));
        break;
      default:
        throw new Error(op);
    }
    return null;
  });
}
const date = "2026-10-19T12:30:00.123456+00:00";
describe("frozen legacy-reference writable data layer", () => {
  it("matches every sqlite_master DDL byte, defaults, indexes and connection pragmas", async () => {
    const ts = fixture("schema-ts");
    ts.db.init();
    ts.db.init();
    expect(snapshot(ts.db, ts.lib.base)).toEqual(reference("init-schema-py"));
    expect(ts.db.get('SELECT "legacy literal" AS s')).toEqual({
      s: "legacy literal"
    });
  });
  it("adds device reading sync storage without changing the legacy reader_progress table", () => {
    const ts = fixture("reading-sync-schema");
    ts.db.init();
    expect(ts.db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'device_reading'")).toMatchObject({ sql: expect.stringContaining("PRIMARY KEY (book_id, device_id)") });
    expect(ts.db.get("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_device_reading_book'")).toMatchObject({ sql: expect.stringContaining("ON device_reading(book_id)") });
    expect(ts.db.all("SELECT * FROM device_reading")).toEqual([]);
    expect(ts.db.get("SELECT sql FROM sqlite_master WHERE name = 'reader_progress'")).toMatchObject({ sql: expect.stringContaining("CREATE TABLE reader_progress") });
  });
  it("ports storage, metadata, book.json, jobs, sessions, progress and wishes without changing persisted encodings", async () => {
    const ts = fixture("crud-ts");
    ts.db.init();
    const book = {
      title: "书,名:😀",
      intro: "简介\n下一行",
      volumes: [{
        title: "卷",
        lines: [],
        chapters: [{
          title: "章",
          lines: ["正文"]
        }]
      }]
    };
    const meta = metadataFromDict({
      book_id: "a",
      title: book.title,
      tags: ["中文", "a, b:c", "😀", "  "],
      created_at: date,
      updated_at: date,
      read: true,
      custom_css: "a { color: red; }"
    });
    const steps: Step[] = [{
      op: "save_metadata",
      args: [meta]
    }, {
      op: "save_book",
      args: [book, "a"]
    }, {
      op: "load_book",
      args: ["a"]
    }, {
      op: "load_metadata",
      args: ["a"]
    }, {
      op: "ensure_book_exists",
      args: ["a"]
    }, ...Array.from({
      length: 28
    }, (_, i): Step => ({
      op: "save_metadata",
      args: [metadataFromDict({
        book_id: `b${i}`,
        title: `Book ${i}`,
        author: i % 2 ? "Author" : "作者",
        created_at: `${i}`.padStart(2, "0"),
        updated_at: i % 2 ? "" : `t${i}`.padStart(3, "0")
      })]
    })), {
      op: "list_books"
    }, {
      op: "list_books",
      kwargs: {
        sort_output: false
      }
    }, ...[{
      page: 1
    }, {
      page: 2
    }, {
      sort: " CREATED ",
      page: 0,
      per_page: 2
    }, {
      q: "book 2"
    }, {
      q: "%_"
    }].map((kwargs): Step => ({
      op: "list_books_page",
      kwargs
    })), {
      op: "create_session",
      args: ["old", date]
    }, {
      op: "create_session",
      args: ["key", date, "passkey", null]
    }, {
      op: "touch_session",
      args: ["old", "later"]
    }, {
      op: "mark_password_verified",
      args: ["old", date]
    }, {
      op: "get_session",
      args: ["old"]
    }, {
      op: "delete_session",
      args: ["key"]
    }, {
      op: "create_job",
      args: [{
        id: "job",
        book_id: "a",
        action: "ingest",
        status: "queued",
        stage: null,
        message: "中文",
        log: "log\nline",
        rule_template: "default",
        created_at: date,
        updated_at: date
      }]
    }, {
      op: "update_job",
      args: ["job"],
      kwargs: {
        status: "failed",
        log: "failed"
      }
    }, {
      op: "get_job",
      args: ["job"]
    }, {
      op: "list_jobs",
      args: ["failed"]
    }, {
      op: "delete_jobs",
      args: [["missing"]]
    }, {
      op: "upsert_reader_progress",
      args: ["a", 2, 3, 10, date]
    }, {
      op: "upsert_reader_progress",
      args: ["a", 3, 0, 20, date]
    }, {
      op: "get_reader_progress",
      args: ["a"]
    }, {
      op: "create_wish",
      args: [{
        id: "wish",
        title: "《书 名》",
        author: "作者-A",
        library_book_id: null,
        rating: 5,
        read: false,
        read_status: "reading",
        tags: ["中文", "科幻"],
        comment: "评论",
        book_status: "ongoing",
        created_at: date,
        updated_at: date
      }]
    }, {
      op: "get_manual_wish_by_identity",
      args: ["书名", "作者 a"]
    }, {
      op: "update_wish",
      args: ["wish"],
      kwargs: {
        title: "新书",
        tags: ["a", "  ", 12, null, true],
        read_status: "read",
        library_book_id: " A "
      }
    }, {
      op: "get_wish_by_library_book_id",
      args: ["a"]
    }, {
      op: "list_wishes"
    }, {
      op: "archive_book",
      args: ["a"]
    }, {
      op: "ensure_book_exists",
      args: ["a"]
    }, {
      op: "list_archived_books"
    }, {
      op: "restore_book",
      args: ["a", date]
    }, {
      op: "load_metadata",
      args: ["a"]
    }, {
      op: "delete_book",
      args: ["a"]
    }, {
      op: "ensure_book_exists",
      args: ["a"]
    }, {
      op: "delete_book",
      args: ["missing"]
    }];
    const actual = {
      results: runSteps(ts.db, ts.lib, steps),
      snapshot: snapshot(ts.db, ts.lib.base)
    };
    expect(actual).toEqual(reference("run-crud-py"));
  });
  it("migrates old sessions and wishlist columns and deterministically deduplicates old wishes", async () => {
    const ts = fixture("legacy-ts");
    const legacy = `CREATE TABLE sessions(session_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, last_seen TEXT NOT NULL);
      INSERT INTO sessions VALUES ('legacy', 'then', 'then');
      CREATE TABLE wishlist(id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT, rating INTEGER, read INTEGER NOT NULL DEFAULT 0, book_status TEXT NOT NULL DEFAULT 'completed', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO wishlist VALUES ('a','《书 名》','作 者',NULL,1,'completed','1','1'), ('b','书名','作者',5,0,'ongoing','2','2');`;
    const conn = connect(ts.db.path);
    conn.exec(legacy);
    conn.close();
    ts.db.init();
    ts.db.init();
    expect(snapshot(ts.db, ts.lib.base)).toEqual(reference("init-legacy-py"));
    expect(ts.db.getSession("legacy")?.password_verified_at).toBeNull();
    expect(ts.db.listWishes().map(w => w.id)).toEqual(["b"]);
  });
  it("migrates active/archive meta.json, preserves DB precedence and invalid files, and reads late legacy metadata", async () => {
    const ts = fixture("meta-ts");
    for (const [folder, data] of [["a", {
      title: "旧书",
      tags: ["中", "文"]
    }], ["archive/b", {
      title: "归档",
      archived: false
    }], ["bad", "{"], ["db-wins", {
      title: "obsolete"
    }]] as const) {
      mkdirSync(join(ts.lib.base, folder), {
        recursive: true
      });
      writeFileSync(join(ts.lib.base, folder, "meta.json"), typeof data === "string" ? data : JSON.stringify(data));
      writeFileSync(join(ts.lib.base, folder, "book.json"), "{}");
    }
    ts.db.init();
    ts.db.run("INSERT INTO books(book_id,title) VALUES ('db-wins','current')");
    ts.lib.ensure();
    expect(snapshot(ts.db, ts.lib.base)).toEqual(reference("migrate-meta-py"));
    mkdirSync(join(ts.lib.base, "late"));
    writeFileSync(join(ts.lib.base, "late/meta.json"), '{"title":"晚到"}');
    expect(ts.lib.loadMetadata("late").title).toBe("晚到");
    expect(existsSync(join(ts.lib.base, "late/meta.json"))).toBe(false);
    expect(() => ts.lib.loadMetadata("missing")).toThrow(/Metadata not found/);
  });
  it("deduplicates linked wishes by updated/created/id and converts blank links to NULL", async () => {
    const ts = fixture("linked-ts");
    const seed = `DROP INDEX idx_wishlist_library_book_unique;
      INSERT INTO wishlist(id,title,library_book_id,created_at,updated_at) VALUES
      ('a','old','book','1','2'), ('b','keep','book','2','2'), ('c','blank','   ','1','1');`;
    ts.db.init();
    ts.db.withConnection(conn => conn.exec(seed));
    ts.db.init();
    expect(snapshot(ts.db, ts.lib.base)).toEqual(reference("init-linked-py"));
    expect(ts.db.getWishByLibraryBookId("book")?.id).toBe("b");
    expect(ts.db.getWish("c")?.library_book_id).toBeNull();
  });
  it("seeds unread tracking once, includes archived/orphan rows, and preserves SQL pagination totals", async () => {
    const ts = fixture("seed-ts");
    const steps: Step[] = [...["a", "b", "c"].map((id, i): Step => ({
      op: "save_metadata",
      args: [metadataFromDict({
        book_id: id,
        title: i === 0 ? "  " : id,
        read: i === 1,
        archived: i === 2,
        created_at: date
      })]
    })), {
      op: "sql",
      args: ["INSERT INTO books(book_id,title,updated_at) VALUES ('orphan','orphan','later')"]
    }, {
      op: "list_books_page",
      kwargs: {
        read_filter: "unread",
        per_page: 1
      }
    }, {
      op: "list_books_page",
      kwargs: {
        read_filter: "unread",
        per_page: 1,
        page: 2
      }
    }];
    ts.db.init();
    const actual = {
      results: runSteps(ts.db, ts.lib, steps),
      snapshot: snapshot(ts.db, ts.lib.base)
    };
    const expected = reference("run-seed-py");
    // Only the random UUID primary keys generated by SQLite's seeding differ.
    for (const result of [actual, expected]) {
      const wishes = result.snapshot.tables.wishlist as Record<string, unknown>[];
      for (const row of wishes) row.id = `seed:${row.library_book_id}`;
      wishes.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    }
    expect(actual).toEqual(expected);
    expect(actual.snapshot.tables.wishlist).toHaveLength(4);
  });
  it("opens and updates the same database in Python → TS → Python → TS order", () => {
    const f = fixture("alternating");
    replayState(f.path, alternatingReplay.steps[0]);
    f.lib.saveMetadata(metadataFromDict({
      book_id: "a",
      title: "TS",
      tags: ["中", "文"],
      created_at: date
    }));
    const steps = [{
      op: "load_metadata",
      args: ["a"]
    }, {
      op: "save_metadata",
      args: [{
        book_id: "a",
        title: "Python",
        tags: ["after", "TS"],
        created_at: date
      }]
    }];
    const result = replayState(f.path, alternatingReplay.steps[1], steps) as { results: { title: string }[] };
    expect(result.results[0].title).toBe("TS");
    expect(f.lib.loadMetadata("a").title).toBe("Python");
    f.db.init();
    expect(snapshot(f.db, f.lib.base)).toEqual(replayState(f.path, alternatingReplay.steps[2]));
  });
  it("matches malformed/heterogeneous tags and legacy read-status decoding", async () => {
    const ts = fixture("decoding-ts");
    ts.db.init();
    const steps: Step[] = [{
      op: "save_metadata",
      args: [{
        book_id: "a",
        title: "tags"
      }]
    }, {
      op: "create_wish",
      args: [{
        id: "w",
        title: "wish",
        created_at: date,
        updated_at: date
      }]
    }];
    for (const tags of ["{", "null", "{}", '["", "  ", "a, : b", 12, null, true, ["中", "a\\nb"], {"a": false}]']) {
      steps.push({
        op: "sql",
        args: [`UPDATE books SET tags_json='${tags}'; UPDATE wishlist SET tags_json='${tags}', read=1, read_status='INVALID'`]
      }, {
        op: "load_metadata",
        args: ["a"]
      }, {
        op: "get_wish",
        args: ["w"]
      });
    }
    const fullSteps = steps.map(step => step.op === "create_wish" ? {
      ...step,
      args: [{
        id: "w",
        title: "wish",
        library_book_id: null,
        author: null,
        rating: null,
        read: false,
        read_status: "unread",
        tags: [],
        comment: null,
        book_status: "completed",
        created_at: date,
        updated_at: date
      }]
    } : step);
    expect({
      results: runSteps(ts.db, ts.lib, fullSteps),
      snapshot: snapshot(ts.db, ts.lib.base)
    }).toEqual(reference("run-decoding-py"));
  });
  it("retains rows and schema when opening a read-only backup of the existing database", (ctx) => {
    // The live library database changes on every login, so the check runs against the private
    // snapshot that was taken together with the Python reference (see scripts/parity-local.md).
    const localRoot = resolve(process.env.BINDERY_LOCAL_PARITY_DIR || ".parity-local");
    const cachePath = join(localRoot, "data", "existing-backup.json"), source = join(localRoot, "data", "bindery.db");
    if (!existsSync(cachePath) && !existsSync(resolve("library/bindery.db"))) return;
    let reason: string | null = null;
    let recorded: { init_raw: RecordedStep; init_after_ts: RecordedStep } | null = null;
    if (!existsSync(cachePath)) reason = `Local Python reference missing: ${cachePath}`;
    else if (!existsSync(source)) reason = `Local database snapshot missing: ${source}`;
    else {
      try {
        const cache = JSON.parse(readFileSync(cachePath, "utf8")) as { source?: { bindery_db_sha256?: string }; init_raw: RecordedStep; init_after_ts: RecordedStep };
        const digest = createHash("sha256").update(readFileSync(source)).digest("hex");
        if (digest !== cache.source?.bindery_db_sha256) reason = `Local database snapshot ${source} does not match ${cachePath}`;
        else recorded = cache;
      } catch (error) { reason = `Cannot read local Python reference ${cachePath}: ${String(error)}`; }
    }
    if (reason || !recorded) { console.warn(`[data parity] ${reason}; skipping real-library database check`); ctx.skip(reason || "Local reference unavailable"); return; }
    const f = fixture("existing-backup"), py = fixture("existing-backup-py");
    copyFileSync(source, f.db.path);
    copyFileSync(f.db.path, py.db.path);
    f.db.init();
    const expected = replayState(py.path, recorded.init_raw);
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
    expect(digest(snapshot(f.db, f.lib.base))).toBe(digest(expected));
    const final = replayState(f.path, recorded.init_after_ts);
    expect(digest(snapshot(f.db, f.lib.base))).toBe(digest(final));
  });
  it("ports file layout, cover sniffing, archive replacement and collision-safe restore", () => {
    const f = fixture("files");
    f.lib.saveMetadata(metadataFromDict({
      book_id: "a",
      title: "file"
    }));
    const source = join(f.path, "source.txt");
    writeFileSync(source, "原文");
    writeSourceFile(f.lib.base, "a", source);
    for (const [hex, ext] of [["ffd8ff", "jpg"], ["89504e470d0a1a0a", "png"], ["474946383961", "gif"], ["524946460000000057454250", "webp"], ["203c7376673e", "svg"], ["00", "jpg"]]) expect(saveCoverBytes(f.lib.base, "a", Buffer.from(hex!, "hex"))).toBe(`cover.${ext}`);
    f.lib.archiveBook("a");
    mkdirSync(bookDir(f.lib.base, "a"));
    expect(() => f.lib.restoreBook("a")).toThrow(/Book exists/);
    rmSync(bookDir(f.lib.base, "a"), {
      recursive: true
    });
    f.lib.restoreBook("a", date);
    expect(readFileSync(join(bookDir(f.lib.base, "a"), "source.txt"), "utf8")).toBe("原文");
    f.lib.archiveBook("a");
    f.lib.deleteBook("a");
    expect(f.db.get("SELECT * FROM books WHERE book_id='a'")).toBeNull();
    expect(() => f.lib.restoreBook("a")).toThrow(/Book not found/);
  });
  it("relocates the legacy root database only when no explicit path or target exists", () => {
    const f = fixture("relocation"),
      project = join(f.path, "project");
    mkdirSync(project);
    const legacy = join(project, "bindery.db");
    writeFileSync(legacy, "legacy");
    const env = {
      BINDERY_LIBRARY_DIR: join(f.path, "target")
    };
    const path = writableDatabasePath(env, f.path, project);
    expect(readFileSync(path, "utf8")).toBe("legacy");
    expect(existsSync(legacy)).toBe(false);
    writeFileSync(legacy, "leave");
    writableDatabasePath(env, f.path, project);
    expect(readFileSync(legacy, "utf8")).toBe("leave");
    writableDatabasePath({
      ...env,
      BINDERY_DB_PATH: "explicit.db"
    }, f.path, project);
    expect(existsSync(legacy)).toBe(true);
  });
});
