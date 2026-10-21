import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { convertToKepubAsync, kepubEntryBytes, readKepubZip } from "../src/core/kepub";

/** Optional real-book check. No kepubify/library access happens without the env vars. */
const kepubify = process.env.KEPUBIFY_BIN;
const library = resolve(process.env.BINDERY_PARITY_LIBRARY || "library");
const reason = !kepubify ? "未设置 KEPUBIFY_BIN" : !existsSync(kepubify) ? `KEPUBIFY_BIN 不存在：${kepubify}` : !existsSync(library) ? `未找到书库目录：${library}（可设置 BINDERY_PARITY_LIBRARY）` : null;

function epubs(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) epubs(path, found);
    else if (/\.epub$/i.test(entry.name)) found.push(path);
  }
  return found;
}

if (reason) {
  console.info(`跳过本机 KEPUB 对照：${reason}。设置 KEPUBIFY_BIN=/path/to/kepubify 和 BINDERY_PARITY_LIBRARY=/path/to/library 后重跑。`);
  it.skip(`optional local kepubify parity (${reason})`, () => {});
} else {
  describe("local kepubify parity", () => {
    it("compares every member of every library EPUB against kepubify v4.0.4", { timeout: 600_000 }, async () => {
      const version = execFileSync(kepubify!, ["--version"], { encoding: "utf8" });
      expect(version).toContain("v4.0.4");
      const files = epubs(library).sort(), temp = mkdtempSync(join(tmpdir(), "bindery-kepub-parity-"));
      let members = 0;
      try {
        for (let index = 0; index < files.length; index++) {
          const source = files[index]!, input = join(temp, `${index}.epub`), output = join(temp, `${index}.kepub.epub`);
          const original = readFileSync(source);
          writeFileSync(input, original);
          execFileSync(kepubify!, ["-o", output, input], { stdio: "pipe" });
          const expected = unzipSync(readFileSync(output));
          const actual = readKepubZip((await convertToKepubAsync(new Uint8Array(original))).data);
          expect(actual.map(entry => entry.name).sort(), source).toEqual(Object.keys(expected).sort());
          for (const entry of actual) {
            const reference = expected[entry.name];
            expect(reference, `${source} → ${entry.name}`).toBeDefined();
            expect(Buffer.from(kepubEntryBytes(entry)).equals(Buffer.from(reference!)), `${source} → ${entry.name}`).toBe(true);
            members++;
          }
          console.info(`KEPUB local parity ${index + 1}/${files.length}: ${source} (${Object.keys(expected).length} members)`);
        }
      } finally { rmSync(temp, { recursive: true, force: true }); }
      console.info(`KEPUB local parity PASS: ${files.length} EPUBs, ${members} members, 0 differences`);
    });
  });
}
