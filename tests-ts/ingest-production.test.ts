import { afterAll, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "bindery-ingest-production-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
it.runIf(existsSync("dist/server/server.js"))("runs authenticated production SSR, multipart HTTP endpoints and background consumption without sockets", async () => {
  await promisify(execFile)(process.execPath, ["tests-ts/fixtures/ingest/production.mjs", root], { timeout: 20000 }); expect(JSON.parse(readFileSync(join(root, "result.json"), "utf8"))).toEqual({ passed: true });
});
