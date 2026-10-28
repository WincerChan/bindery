import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "vite";
import { binderyIcons } from "../scripts/vite-icons";
import solid from "vite-plugin-solid";

const temporary = mkdtempSync(join(tmpdir(), "bindery-redirect-client-"));
beforeAll(async () => {
  await build({ configFile: false, plugins: [...binderyIcons(), solid()], resolve: { conditions: ["browser", "development"] }, logLevel: "silent", build: {
    target: "esnext", minify: false, lib: { entry: resolve("tests-ts/fixtures/spa/redirect-client.tsx"), formats: ["es"], fileName: () => "client.mjs" }, outDir: temporary,
  } });
}, 120_000);
afterAll(() => rmSync(temporary, { recursive: true, force: true }));
it("runs compiled authenticated SPA mutations and original WebAuthn endpoints with unchanged cookies", () => {
  expect(existsSync(resolve("dist/server/server.js")), "Run pnpm build before the production checks").toBe(true);
  const stdout = execFileSync(process.execPath, ["tests-ts/fixtures/spa/production.mjs"], { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 });
  expect(stdout).toContain("Compiled SPA RPC checks passed: tracker CRUD, FormData book write");
}, 65_000);
it("redirects anonymous loader/mutation RPCs through the full production entry with global default authentication", () => {
  const stdout = execFileSync(process.execPath, ["tests-ts/fixtures/spa/redirect-probe.mjs", join(temporary, "client.mjs")], { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 });
  const evidence = JSON.parse(stdout.trim().split("\n").at(-1)!);
  expect(evidence.productionRedirects).toHaveLength(6);
  expect(evidence.entrance).toHaveLength(12);
  expect(evidence.authenticationBeforeValidation).toBe(true);
  expect(evidence.anonymousLogin).toMatchObject({ loader: true, ssr: 200, password: 303, passkey: 404 });
  expect(evidence.authenticated).toEqual({ loader: true, mutation: true, api: 200, libraryContext: true });
  expect(evidence.expiredSession).toEqual({ loader: true, mutation: true, noWrite: true });
  console.log("Compiled redirect evidence:", JSON.stringify(evidence));
}, 65_000);
