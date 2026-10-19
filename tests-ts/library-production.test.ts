import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { it } from "vitest";

it.runIf(existsSync("dist/server/server.js"))("serves library SSR, partial HTML, bulk POSTs and authenticated RPC without sockets", async () => {
  await promisify(execFile)(process.execPath, ["tests-ts/fixtures/library/production.mjs"], { timeout: 20000 });
});
