import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, ViteDevServer } from "vite";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { canCacheResponse, cachePrefix, outdatedCaches, requestStrategy, type PwaRequest } from "../src/client/pwa/policy";
import { collectPrecache, pwaBuild } from "../src/client/pwa/build";
import { manifest } from "../src/client/pwa/manifest";

const scope = "https://bindery.example/";
const request = (path: string, init: RequestInit = {}): PwaRequest => new Request(new URL(path, scope), init);
const navigate = (path: string): PwaRequest => ({ ...request(path), url: new URL(path, scope).href, method: "GET", mode: "navigate", headers: new Headers() });
const precache = ["manifest.json", "offline.html", "favicon.svg", "logo.svg", "icons/icon-192.png"];

describe("PWA cache privacy boundary", () => {
  it.each(["/", "/?q=私人书籍", "/login?next=/", "/book/a/preview/0", "/devices"])("uses the network with a public offline fallback for navigation %s", path => {
    expect(requestStrategy(navigate(path), scope, precache)).toBe("network-first");
  });
  it.each([
    "/api/books", "/_serverFn/data/123?args=secret", "/_serverFn/action/123",
    "/login/data", "/book/a/epub/OEBPS/chapter.html", "/book/a/download", "/book/a/cover?v=1",
    "/covers/a.png", "/downloads/book", "/assets/book.epub", "/assets/private.kfx", "/security/data", "/unknown",
  ])("never caches dynamic/private request %s", path => {
    expect(requestStrategy(request(path), scope, precache)).toBe("network-only");
  });
  it.each(["/book/a/epub/OEBPS/a.html", "/book/a/cover", "/book/a/download", "/_serverFn/data/123", "/api/books"])("does not substitute HTML for navigated private resources %s", path => {
    expect(requestStrategy(navigate(path), scope, precache)).toBe("network-only");
  });
  it.each(["/assets/app-Ab12cd34.js", "/assets/app-Ab12cd34.css", "/assets/kindle-worker-Ab12cd34.js", "/assets/boko_bg-Ab12cd34.wasm", "/assets/boko.wasm", "/assets/workers/boko.wasm", "/icons/icon-192.png", "/offline.html", "/manifest.json", "/logo.svg"])("uses cache-first for public static asset %s", path => {
    expect(requestStrategy(request(path), scope, precache)).toBe("cache-first");
  });
  it.each([
    request("/assets/app-Ab12cd34.js", { method: "POST" }),
    request("/assets/app-Ab12cd34.js", { method: "HEAD" }),
    request("/assets/app-Ab12cd34.js", { headers: { Range: "bytes=0-9" } }),
    request("/assets/app-Ab12cd34.js", { headers: { Authorization: "Bearer secret" } }),
    request("/assets/app-Ab12cd34.js?private=1"), request("/assets/app.js"),
    request("https://other.example/assets/app-Ab12cd34.js"), request("/assets/%61pp-Ab12cd34.js"),
  ])("bypasses non-public or non-canonical asset requests (%#)", value => {
    expect(requestStrategy(value, scope, precache)).toBe("network-only");
  });
  it("respects the origin and directory scope", () => {
    const subScope = scope + "bindery/";
    expect(requestStrategy(request("/assets/app-Ab12cd34.js"), subScope)).toBe("network-only");
    expect(requestStrategy(navigate("/bindery-other/"), subScope)).toBe("network-only");
    expect(requestStrategy(request("/bindery/assets/app-Ab12cd34.js"), subScope)).toBe("cache-first");
  });
  it.each([
    new Response("error", { status: 404, headers: { "Content-Type": "text/javascript" } }),
    new Response("login", { headers: { "Content-Type": "text/html" } }),
    new Response("private", { headers: { "Content-Type": "text/javascript", "Cache-Control": "private, max-age=600" } }),
    new Response("secret", { headers: { "Content-Type": "text/javascript", "Cache-Control": "no-store" } }),
    Response.redirect("https://bindery.example/login", 303),
  ])("rejects cache poisoning through invalid static responses (%#)", response => {
    expect(canCacheResponse(request("/assets/app-Ab12cd34.js"), response, scope, precache)).toBe(false);
  });
  it("requires a matching public MIME type, even for WASM", () => {
    const wasm = request("/assets/boko.wasm");
    expect(canCacheResponse(wasm, new Response("wasm", { headers: { "Content-Type": "application/wasm" } }), scope, precache)).toBe(true);
    expect(canCacheResponse(wasm, new Response("login", { headers: { "Content-Type": "text/html" } }), scope, precache)).toBe(false);
    expect(canCacheResponse(navigate("/"), new Response("private SSR", { headers: { "Content-Type": "text/html" } }), scope, precache)).toBe(false);
  });
});

describe("PWA build and cache generations", () => {
  it("collects lazy JS/CSS from the client manifest plus separately emitted Worker/WASM files", () => {
    const list = collectPrecache({ entry: { file: "assets/app-Ab12cd34.js", css: ["assets/app-Ab12cd34.css"] }, lazy: { file: "assets/lazy-Ab12cd34.js", assets: ["assets/boko_bg-Ab12cd34.wasm"] } }, ["assets/worker-Ab12cd34.js", "assets/boko_bg-Ab12cd34.wasm", "book/secret.epub", ".vite/manifest.json"]);
    expect(list).toEqual(expect.arrayContaining(["assets/app-Ab12cd34.js", "assets/app-Ab12cd34.css", "assets/lazy-Ab12cd34.js", "assets/worker-Ab12cd34.js", "assets/boko_bg-Ab12cd34.wasm", "offline.html", "manifest.json"]));
    expect(list).not.toContain("book/secret.epub"); expect(list).not.toContain(".vite/manifest.json");
    expect(list.filter(path => path.endsWith(".wasm"))).toHaveLength(1);
  });
  it("only deletes obsolete generations belonging to this app scope", () => {
    const current = cachePrefix(scope) + "new";
    const old = cachePrefix(scope) + "old", otherScope = cachePrefix(scope + "other/") + "old";
    expect(outdatedCaches([old, current, otherScope, "some-other-app"], current, scope)).toEqual([old]);
    expect(outdatedCaches([current], current, scope)).toEqual([]);
  });
});

describe("install manifest and PNG icons", () => {
  it("regenerates the favicon and PNGs from the curved SVG without stale exports", () => {
    const root = mkdtempSync(join(tmpdir(), "bindery-logo-"));
    try {
      const script = "src/client/pwa/generate-icons.mjs";
      mkdirSync(join(root, "src/client/pwa"), { recursive: true });
      mkdirSync(join(root, "public"));
      copyFileSync(script, join(root, script));
      copyFileSync("public/logo.svg", join(root, "public/logo.svg"));
      execFileSync(process.execPath, [join(root, script)], { timeout: 10000 });
      for (const file of ["public/favicon.svg", ...manifest.icons.map(icon => "public" + icon.src)]) {
        expect(readFileSync(join(root, file))).toEqual(readFileSync(file));
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("declares the root-scoped standalone Bindery app with design token colours", () => {
    expect(manifest).toMatchObject({ id: "/", name: "Bindery", short_name: "Bindery", start_url: "/", scope: "/", display: "standalone", lang: "zh-CN" });
    const styles = readFileSync("src/styles.css", "utf8");
    for (const color of [manifest.theme_color, manifest.background_color]) expect(styles).toContain(color);
    expect(manifest.icons.map(icon => icon.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(manifest.icons.some(icon => icon.purpose === "maskable")).toBe(true);
  });
  it.each(manifest.icons)("ships a real opaque PNG at $src with the declared dimensions and safe mask", icon => {
    const bytes = readFileSync("public" + icon.src);
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const size = Number(icon.sizes.split("x")[0]);
    expect(bytes.readUInt32BE(16)).toBe(size); expect(bytes.readUInt32BE(20)).toBe(size);
    expect(bytes[25]).toBe(2); // RGB, opaque.
    const chunks: Buffer[] = [];
    for (let offset = 8; offset < bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (bytes.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
      offset += length + 12;
    }
    const pixels = inflateSync(Buffer.concat(chunks));
    if (size === 192) {
      const pixel = (x: number, y: number) => [...pixels.subarray(y * (size * 3 + 1) + 1 + x * 3, y * (size * 3 + 1) + 4 + x * 3)];
      // Inside the curved edge, outside its endpoint chord; preserve the central gap.
      expect(pixel(77, 46)).toEqual([78, 66, 105]);
      expect(pixel(96, 108)).toEqual([245, 246, 243]);
    }
    let foreground = 0, minX = size, minY = size, maxX = -1, maxY = -1;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const offset = y * (size * 3 + 1) + 1 + x * 3;
      if (pixels[offset] === 245 && pixels[offset + 1] === 246 && pixels[offset + 2] === 243) continue;
      foreground++;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      if (icon.purpose === "maskable") expect(Math.hypot(x + .5 - size / 2, y + .5 - size / 2)).toBeLessThan(size * .4);
    }
    expect(foreground).toBeGreaterThan(size * size * .1);
    // Actual ink bounds must be centered, including on maskable app icons.
    expect(Math.abs(minX - (size - 1 - maxX))).toBeLessThanOrEqual(1);
    expect(Math.abs(minY - (size - 1 - maxY))).toBeLessThanOrEqual(1);
  });
});

it("serves the same valid manifest in Vite dev without a server or socket", () => {
  let middleware!: Connect.NextHandleFunction;
  const hook = pwaBuild().configureServer;
  if (typeof hook !== "function") throw new Error("Missing dev manifest hook");
  hook.call({} as never, { middlewares: { use: (handler: Connect.NextHandleFunction) => { middleware = handler; } } } as unknown as ViteDevServer);
  for (const method of ["GET", "HEAD"]) {
    const headers = new Map<string, unknown>(); let body: string | undefined;
    middleware({ url: "/manifest.json?v=dev", method } as IncomingMessage, {
      setHeader: (name: string, value: unknown) => headers.set(name, value), end: (value?: string) => { body = value; },
    } as unknown as ServerResponse, () => { throw new Error("Manifest fell through to HTML"); });
    expect(headers.get("Content-Type")).toBe("application/manifest+json; charset=utf-8");
    expect(headers.get("Cache-Control")).toBe("no-cache");
    if (method === "GET") expect(JSON.parse(body!)).toEqual(manifest); else expect(body).toBeUndefined();
  }
  let calls = 0;
  for (const request of [{ url: "/", method: "GET" }, { url: "/manifest.json", method: "POST" }]) middleware(request as IncomingMessage, {} as ServerResponse, () => { calls++; });
  expect(calls).toBe(2);
});
