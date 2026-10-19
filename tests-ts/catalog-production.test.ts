import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.runIf(existsSync("dist/server/server.js"))("serves catalog pages and both tracker URL families through the production handler without sockets", async () => {
  const root = await mkdtemp(join(tmpdir(), "bindery-catalog-check-")), result = join(root, "result.txt");
  try {
    await promisify(execFile)(process.execPath, ["tests-ts/fixtures/catalog/production.mjs", result], { timeout: 20000, maxBuffer: 2_000_000 });
    expect(await readFile(result, "utf8")).toBe("Catalog production fetch checks passed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
