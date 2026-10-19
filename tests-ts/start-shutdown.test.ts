import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";

async function signalChild(signal: NodeJS.Signals, mode = "normal") {
  const root = mkdtempSync(join(tmpdir(), "bindery-signals-"));
  try {
    const result = await new Promise<{ code: number | string; signal: NodeJS.Signals | null; stderr: string }>(resolve => {
      execFile(process.execPath, ["tests-ts/fixtures/shutdown/signals.mjs", root, mode, signal], { timeout: 15000 }, (error, _stdout, stderr) => {
        resolve({ code: error?.code ?? 0, signal: error?.signal ?? null, stderr });
      });
    });
    expect(result.signal, result.stderr).toBeNull();
    expect(existsSync(join(root, "library", ".ingest-queue", ".consumer"))).toBe(false);
    return { ...result, events: readFileSync(join(root, "events.txt"), "utf8").trim().split("\n") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

it.runIf(existsSync("dist/server/server.js")).each(["SIGTERM", "SIGINT"] as const)("handles %s and repeated signals in a real child without sockets", async signal => {
  const result = await signalChild(signal);
  expect(result.code, result.stderr).toBe(0);
  expect(result.events).toEqual(["close", "runtime", "closed"]);
});

it.runIf(existsSync("dist/server/server.js")).each(["timeout-http", "shutdown-error"])("exits nonzero after cleaning up for %s", async mode => {
  const result = await signalChild("SIGTERM", mode);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(mode === "timeout-http" ? "Runtime shutdown timed out" : "Fixture shutdown failure");
  expect(result.events).toContain("force");
  expect(result.events).toContain("runtime");
});
