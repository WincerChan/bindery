import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { metadataFromDict } from "../src/core/models";
import { CountArchive } from "../src/server/books/count-archive";
import { countEpubWords } from "../src/server/books/word-count-estimate";
import { loadBookPage } from "../src/server/books/service";
import { BinderyDatabase } from "../src/server/db";
import { LibraryStorage, epubPath } from "../src/server/storage";

// Opt-in only. External files are opened for reading; every DB/template write is temporary.
const base = process.env.BINDERY_WORD_COUNT_BENCH_LIBRARY;
const fingerprint = (path: string) => ({ size: statSync(path).size, mtime: statSync(path).mtimeMs, hash: createHash("sha256").update(readFileSync(path)).digest("hex") });
const archive = (path: string) => new CountArchive(path, statSync(path, { bigint: true }), () => {});
it.skipIf(!base)("compares sampled and exact counts on the read-only library", () => {
  const dbPath = join(resolve(base!), "bindery.db"), beforeDb = fingerprint(dbPath);
  for (const entry of readdirSync(base!, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^[a-f0-9]{32}$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(base!, entry.name, "book.epub"), before = fingerprint(path);
    const start = performance.now(), estimate = countEpubWords(archive(path)), estimateMs = performance.now() - start;
    const exact = countEpubWords(archive(path), true), errorPercent = exact.count ? (estimate.count / exact.count - 1) * 100 : 0;
    console.log(JSON.stringify({ id: entry.name, bytes: before.size, ...estimate, exact: exact.count, errorPercent, estimateMs }));
    expect(Math.abs(errorPercent)).toBeLessThan(10);
    expect(fingerprint(path)).toEqual(before);
  }
  expect(fingerprint(dbPath)).toEqual(beforeDb);
});
it.skipIf(!base).each([
  ["21 MB", "0c24b86a83704131b6f24e800ead9b93"],
  ["4 MB", "0e95302adb0447d3b0fef13dd033d22e"],
])("times first detail loads and cache hits: %s", (_label, id) => {
  const source = join(resolve(base!), id, "book.epub"), sourceDb = join(resolve(base!), "bindery.db");
  const before = [fingerprint(source), fingerprint(sourceDb)], root = mkdtempSync(join(tmpdir(), "bindery-count-bench-"));
  const library = new LibraryStorage(join(root, "library"), new BinderyDatabase(join(root, "bindery.db")));
  try {
    vi.stubEnv("BINDERY_TEMPLATE_DIR", join(root, "templates"));
    library.saveMetadata(metadataFromDict({ book_id: id, title: "Benchmark", source_type: "epub" }));
    const path = epubPath(library.base, id);
    mkdirSync(dirname(path), { recursive: true }); symlinkSync(source, path);
    let start = performance.now();
    const first = loadBookPage(id, "/", library), coldFirstLoadMs = performance.now() - start;
    expect(first.book.word_count).not.toBeNull();
    const warmFirstLoadMs: number[] = [], cacheHitMs: number[] = [];
    for (let i = 0; i < 5; i++) {
      library.db.run("UPDATE books SET word_count_key = NULL WHERE book_id = ?", id);
      start = performance.now(); const warm = loadBookPage(id, "/", library); warmFirstLoadMs.push(performance.now() - start);
      expect(warm.book.word_count).toBe(first.book.word_count);
      start = performance.now(); loadBookPage(id, "/", library); cacheHitMs.push(performance.now() - start);
    }
    console.log(JSON.stringify({ id, count: first.book.word_count, coldFirstLoadMs, warmFirstLoadMs, cacheHitMs }));
    expect([fingerprint(source), fingerprint(sourceDb)]).toEqual(before);
  } finally { library.db.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});
