import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writeArchive } from "../src/core/archive";
import { signIn } from "../src/server/auth";
import { epubPath } from "../src/server/storage";
import { obfuscatedEpub } from "./fixtures/reader/obfuscated";
import { readerFixture } from "./fixtures/reader/support";
it.runIf(existsSync("dist/server/server.js"))("serves reader SSR, redirects, APIs and isolated Unicode EPUB paths through the production handler without sockets", async () => {
  const { root, id, library, cleanup } = readerFixture();
  try {
    const path = epubPath(library.base, id), book = obfuscatedEpub(), entries = book.entries;
    writeFileSync(join(root, "production-paths.json"), JSON.stringify({ paths: book.paths, css: book.css, image: book.image, font: book.font, importedCss: book.importedCss }));
    entries.push({ name: "Text/第一 章.xhtml", data: new TextEncoder().encode('<html><head><meta http-equiv="refresh" content="0;url=/security"/></head><body><script>parent.attack()</script><iframe src="/security"></iframe><form><input/></form><p>隔离正文</p><img src="missing" onerror="alert(1)"/></body></html>') });
    writeFileSync(path, writeArchive(entries));
    await promisify(execFile)(process.execPath, ["tests-ts/fixtures/reader/production.mjs", root, id, signIn(library.db)], { timeout: 20000 });
    expect(JSON.parse(readFileSync(join(root, "production-result.json"), "utf8"))).toEqual({ ok: true });
  } finally { cleanup(); }
});
