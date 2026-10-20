import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryStorage } from "../src/server/storage";
import { BinderyDatabase } from "../src/server/db";
import { signIn } from "../src/server/auth";

const scope = vi.hoisted(() => ({ request: null as Request | null, library: null as LibraryStorage | null, setStatus: vi.fn() }));
vi.mock("@tanstack/solid-start/server", () => ({ getRequest: () => scope.request, setResponseStatus: scope.setStatus }));
vi.mock("@tanstack/solid-router", async () => {
  const { createRequire } = await import("node:module"), require = createRequire(import.meta.url);
  return import(createRequire(require.resolve("@tanstack/solid-router")).resolve("@tanstack/router-core"));
});
vi.mock("@tanstack/solid-start", () => ({ createMiddleware: () => ({ server: (server: unknown) => ({ options: { server } }) }) }));
vi.mock("../src/server/runtime", () => ({ getLibrary: () => scope.library }));
import { authenticated } from "../src/server/functions";
import { HttpError } from "../src/server/http";
import { isRedirect } from "@tanstack/solid-router";
import { loginTarget } from "../src/shared/session-navigation";

const root = mkdtempSync(join(tmpdir(), "bindery-function-boundary-"));
let sequence = 0;
beforeEach(() => {
  vi.clearAllMocks();
  const dir = join(root, String(sequence++));
  scope.library = new LibraryStorage(join(dir, "library"), new BinderyDatabase(join(dir, "data.db")));
  scope.library.ensure();
  scope.request = new Request("http://localhost/jobs");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
function invoke(next: (value?: unknown) => Promise<unknown>) {
  return authenticated.options.server!({ next } as never);
}
function login() {
  scope.request = new Request("http://localhost/jobs", { headers: { Cookie: `bindery_session=${signIn(scope.library!.db)}` } });
}
describe("authenticated server-function middleware", () => {
  it("blocks direct unauthenticated RPC execution before the handler", async () => {
    const next = vi.fn();
    await expect(invoke(next)).rejects.toMatchObject({ options: { href: "/login?next=%2F" } });
    expect(next).not.toHaveBeenCalled();
  });
  it.each([
    ["http://localhost/tracker?q=%E4%B8%AD%E6%96%87&page=3#ignored", "/tracker?q=%E4%B8%AD%E6%96%87&page=3"],
    ["https://evil.test/tracker", "/"],
    ["http://localhost:3000/security", "/"],
    ["https://localhost/security", "/"],
    ["/relative", "/"],
    ["invalid", "/"],
    ["", "/"],
  ])("uses only a valid same-origin Referer (%s) for the login target", async (referer, target) => {
    scope.request = new Request("http://localhost/_serverFn/rpc", { headers: { Referer: referer } });
    try { await invoke(vi.fn()); throw new Error("Expected redirect"); }
    catch (error) { expect(isRedirect(error)).toBe(true); expect(error).toMatchObject({ options: { href: loginTarget(target) } }); }
    expect(loginTarget("//evil.test/path")).toBe("/login?next=%2F");
    expect(loginTarget("https://evil.test/path")).toBe("/login?next=%2F");
  });
  it("passes the real authenticated library only as server context", async () => {
    login(); const next = vi.fn(async () => ({ result: true }));
    expect(await invoke(next)).toEqual({ result: true });
    expect(next).toHaveBeenCalledWith({ context: { library: scope.library } });
    expect(scope.setStatus).not.toHaveBeenCalled();
  });
  it("maps business failures to their HTTP status and preserves redirects", async () => {
    login();
    await expect(invoke(async () => { throw new HttpError(404, "书籍不存在"); })).rejects.toMatchObject({ status: 404, message: "书籍不存在" });
    expect(scope.setStatus).toHaveBeenCalledWith(404);
    const redirect = new Response(null, { status: 303, headers: { Location: "/jobs" } });
    await expect(invoke(async () => { throw redirect; })).rejects.toBe(redirect);
  });
  it("hides unknown server error details", async () => {
    login(); const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(invoke(async () => { throw new Error("private-path-and-data"); })).rejects.toMatchObject({ status: 500, message: "服务器内部错误" });
      expect(scope.setStatus).toHaveBeenCalledWith(500); expect(logger).toHaveBeenCalledOnce();
    } finally { logger.mockRestore(); }
  });
});
