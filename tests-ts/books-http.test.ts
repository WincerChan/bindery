import { afterAll, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { LibraryStorage, saveBook, epubPath } from "../src/server/storage";
import { BinderyDatabase } from "../src/server/db";
import { metadataFromDict, bookFromDict } from "../src/core/models";
import { buildEpub } from "../src/core/epub";
import { signIn } from "../src/server/auth";
const root = mkdtempSync(join(tmpdir(), "bindery-books-http-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const exec = promisify(execFile),
  png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X4D1kAAAAASUVORK5CYII=",
    "base64",
  );
it.runIf(existsSync("dist/server/server.js"))(
  "matches Python read/edit/cover/archive/restore/delete side effects through authenticated production fetch without sockets",
  async () => {
    const tsRoot = join(root, "ts"),
      pyRoot = join(root, "python");
    mkdirSync(tsRoot, { recursive: true });
    mkdirSync(pyRoot, { recursive: true });
    for (const dir of [tsRoot, pyRoot])
      writeFileSync(join(dir, "png.hex"), png.toString("hex"));
    const db = new BinderyDatabase(join(tsRoot, "data.db")),
      library = new LibraryStorage(join(tsRoot, "library"), db);
    library.ensure();
    const id = "a".repeat(32),
      book = bookFromDict({
        title: "示例书",
        author: "作者",
        root_chapters: [{ title: "第一章", lines: ["hello"] }],
      }),
      meta = metadataFromDict({
        book_id: id,
        title: "示例书",
        author: "作者",
        source_type: "epub",
        created_at: "2026-02-06T00:00:00+00:00",
        updated_at: "2026-02-06T00:00:00+00:00",
        epub_updated_at: "2026-02-06T00:00:00+00:00",
      });
    saveBook(book, library.base, id);
    library.saveMetadata(meta);
    writeFileSync(epubPath(library.base, id), buildEpub(book, meta));
    await Promise.all([
      exec(
        process.execPath,
        [
          resolve("tests-ts/fixtures/books/production.mjs"),
          tsRoot,
          `bindery_session=${signIn(db)}`,
        ],
        { timeout: 20000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 },
      ),
      exec(
        "uv",
        [
          "run",
          "--no-sync",
          "python",
          resolve("tests-ts/fixtures/books/reference.py"),
          "flow",
          pyRoot,
        ],
        { timeout: 20000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 },
      ),
    ]);
    expect(
      JSON.parse(readFileSync(join(tsRoot, "result.json"), "utf8")),
    ).toEqual(JSON.parse(readFileSync(join(pyRoot, "result.json"), "utf8")));
  },
);
