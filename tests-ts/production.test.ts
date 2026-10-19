import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { it } from "vitest";
// Unit/parity tests remain usable before building. The acceptance sequence builds first.
it.runIf(existsSync("dist/server/server.js"))(
  "serves production SSR, assets and RPC without opening a socket",
  async () => {
    await promisify(execFile)(process.execPath, ["scripts/check-ssr.mjs"], {
      timeout: 20000,
    });
  },
);
