import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { cachePrefix } from "../src/client/pwa/policy";
import { manifest } from "../src/client/pwa/manifest";

const built = existsSync("dist/client/sw.js");
const scope = "https://bindery.example/";
type Build = { version: string; precache: string[] };
const buildInfo = (): Build => JSON.parse(readFileSync("dist/client/.vite/pwa.json", "utf8"));
const mime = (url: string) => {
  const extension = new URL(url, scope).pathname.split(".").at(-1)!;
  return ({ js: "text/javascript", css: "text/css", wasm: "application/wasm", png: "image/png", svg: "image/svg+xml", json: "application/json", html: "text/html" } as Record<string, string>)[extension];
};

// Execute the actual generated worker in Node with an in-memory Cache Storage.
// FSA is not used by this slice. No sockets or browser globals are installed.
function workerHarness() {
  const stores = new Map<string, Map<string, Response>>();
  const url = (value: Request | string) => typeof value === "string" ? value : value.url;
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        put: async (request: Request | string, response: Response) => { store.set(url(request), response.clone()); },
        match: async (request: Request | string) => store.get(url(request))?.clone(),
      };
    },
    keys: async () => [...stores.keys()],
    delete: vi.fn(async (name: string) => stores.delete(name)),
  };
  const handlers = new Map<string, (event: any) => void>();
  const fetcher = vi.fn(async (request: Request) => new Response("static asset", { headers: { "Content-Type": mime(request.url) } }));
  const clients = [{ id: "one", url: scope, postMessage: vi.fn() }];
  const skipWaiting = vi.fn().mockResolvedValue(undefined);
  runInNewContext(readFileSync("dist/client/sw.js", "utf8"), {
    URL, Request, Response, caches, fetch: fetcher,
    registration: { scope }, clients: { matchAll: async () => clients }, skipWaiting,
    addEventListener: (name: string, listener: (event: any) => void) => handlers.set(name, listener),
  });
  const dispatch = async (type: string, input: Record<string, unknown> = {}) => {
    const background: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    handlers.get(type)!({ ...input, waitUntil: (promise: Promise<unknown>) => background.push(promise), respondWith: (value: Promise<Response>) => { response = value; } });
    const result = await response;
    while (background.length) await Promise.all(background.splice(0));
    return result;
  };
  const request = (path: string, navigate = false) => {
    const value = new Request(new URL(path, scope));
    // Node's Request constructor cannot create mode:navigate, Chrome supplies it.
    if (navigate) Object.defineProperty(value, "mode", { value: "navigate" });
    return value;
  };
  return { stores, caches, fetcher, clients, skipWaiting, dispatch, request };
}

describe.runIf(built)("generated PWA worker", () => {
  it("precaches every build asset and the complete vendored WASM with usable glue", async () => {
    const info = buildInfo(), h = workerHarness();
    expect(info.precache).not.toContain("/"); expect(info.precache).not.toContain("login");
    const clientManifest = JSON.parse(readFileSync("dist/client/.vite/manifest.json", "utf8"));
    for (const entry of Object.values(clientManifest) as { file: string; css?: string[] }[]) {
      expect(info.precache).toContain(entry.file);
      for (const css of entry.css ?? []) expect(info.precache).toContain(css);
    }
    for (const file of info.precache) expect(existsSync(resolve("dist/client", file)), file).toBe(true);
    const wasm = info.precache.find(path => /boko_bg-.*\.wasm$/.test(path))!;
    expect(wasm).toBeTruthy();
    expect(createHash("sha256").update(readFileSync("dist/client/" + wasm)).digest("hex")).toBe("e50c279ce8c97b86abcf668b7dcc2534d93b2782f194b67a23b4b776b5554811");
    const glue = info.precache.find(path => /boko-.*\.js$/.test(path))!;
    expect(readFileSync("dist/client/" + glue, "utf8")).toContain(`new URL('${wasm.split("/").at(-1)}', import.meta.url)`);
    await h.dispatch("install");
    const cache = h.stores.get(cachePrefix(scope) + info.version)!;
    expect([...cache.keys()].sort()).toEqual(info.precache.map(path => new URL(path, scope).href).sort());
    expect(h.fetcher.mock.calls.every(([request]) => request.credentials === "omit" && request.redirect === "error")).toBe(true);
    expect(h.skipWaiting).not.toHaveBeenCalled();
  });
  it("fails installation atomically when a static asset resolves to a login page", async () => {
    const h = workerHarness();
    h.fetcher.mockImplementation(async () => new Response("login", { headers: { "Content-Type": "text/html" } }));
    await expect(h.dispatch("install")).rejects.toThrow("Invalid PWA asset");
    expect(h.stores.size).toBe(0); expect(h.skipWaiting).not.toHaveBeenCalled();
  });
  it("bounds concurrent precache downloads instead of fetching the whole build at once", async () => {
    const h = workerHarness();
    let active = 0, peak = 0;
    h.fetcher.mockImplementation(async request => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 0));
      active--;
      return new Response("static asset", { headers: { "Content-Type": mime(request.url) } });
    });
    await h.dispatch("install");
    expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(4);
    expect(h.fetcher).toHaveBeenCalledTimes(buildInfo().precache.length);
  });
  it("waits for in-flight downloads before removing a failed cache and reports the failed URL", async () => {
    const h = workerHarness(), previous = cachePrefix(scope) + "previous";
    await h.caches.open(previous);
    let release!: () => void, finished = false;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    h.fetcher.mockImplementationOnce(async () => { throw new TypeError("Failed to fetch"); });
    h.fetcher.mockImplementationOnce(async request => {
      await delayed;
      return new Response("static asset", { headers: { "Content-Type": mime(request.url) } });
    });
    const installation = h.dispatch("install").finally(() => { finished = true; });
    const failure = expect(installation).rejects.toThrow(buildInfo().precache[0]);
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(finished).toBe(false); expect(h.caches.delete).not.toHaveBeenCalled();
      expect(h.fetcher.mock.calls.length).toBeLessThanOrEqual(4);
    } finally { release(); await failure; }
    expect([...h.stores.keys()]).toEqual([previous]);
    expect(h.skipWaiting).not.toHaveBeenCalled();
  });
  it("cleans old app generations on activation and preserves other caches", async () => {
    const h = workerHarness(), current = cachePrefix(scope) + buildInfo().version;
    await h.caches.open(current); await h.caches.open(cachePrefix(scope) + "old");
    await h.caches.open("other-app"); await h.caches.open(cachePrefix(scope + "other/") + "old");
    await h.dispatch("activate");
    expect(h.stores.has(current)).toBe(true); expect(h.stores.has("other-app")).toBe(true);
    expect(h.caches.delete).toHaveBeenCalledExactlyOnceWith(cachePrefix(scope) + "old");
  });
  it("returns streaming navigation and auth redirect responses untouched without caching HTML", async () => {
    const h = workerHarness();
    for (const response of [Response.redirect(scope + "login", 303), new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("SSR chunk")); controller.close(); } }), { headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } })]) {
      h.fetcher.mockResolvedValueOnce(response);
      const result = await h.dispatch("fetch", { request: h.request("/", true) });
      expect(result).toBe(response); expect(response.bodyUsed).toBe(false);
    }
    expect(h.stores.size).toBe(0);
  });
  it("falls back to the Chinese offline page without exposing saved library HTML", async () => {
    const h = workerHarness();
    const cache = await h.caches.open(cachePrefix(scope) + buildInfo().version);
    await cache.put(new URL("offline.html", scope).href, new Response(readFileSync("dist/client/offline.html"), { headers: { "Content-Type": "text/html" } }));
    h.fetcher.mockRejectedValueOnce(new TypeError("offline"));
    const response = await h.dispatch("fetch", { request: h.request("/?q=private", true) });
    expect(await response!.text()).toContain("书库需要连接服务器");
    expect([...h.stores.values()][0].size).toBe(1);
  });
  it.each(["/_serverFn/data/123", "/api/books", "/book/a/epub/OEBPS/chapter.html", "/book/a/cover", "/book/a/download"])("leaves %s entirely to the browser network stack", async path => {
    const h = workerHarness();
    expect(await h.dispatch("fetch", { request: h.request(path) })).toBeUndefined();
    expect(h.fetcher).not.toHaveBeenCalled(); expect(h.stores.size).toBe(0);
  });
  it("runtime-caches Vite WASM and serves it offline on later requests", async () => {
    const h = workerHarness(), request = h.request("/assets/kindle-Ab12cd34.wasm");
    expect(await (await h.dispatch("fetch", { request }))!.text()).toBe("static asset");
    h.fetcher.mockRejectedValue(new TypeError("offline"));
    expect(await (await h.dispatch("fetch", { request }))!.text()).toBe("static asset");
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it("never stores a runtime asset redirected to login", async () => {
    const h = workerHarness(); h.fetcher.mockResolvedValueOnce(Response.redirect(scope + "login", 303));
    const result = await h.dispatch("fetch", { request: h.request("/assets/kindle-Ab12cd34.wasm") });
    expect(result!.status).toBe(303); expect([...h.stores.values()][0].size).toBe(0);
  });
  it("acknowledges a reload before activating, but refuses activation with another open tab", async () => {
    const h = workerHarness();
    h.clients.push({ id: "two", url: scope + "kindle", postMessage: vi.fn() });
    await h.dispatch("message", { source: h.clients[0], data: { type: "BINDERY_ACTIVATE_ON_RELOAD" } });
    expect(h.skipWaiting).not.toHaveBeenCalled(); expect(h.clients[0].postMessage).not.toHaveBeenCalled();
    h.clients.pop();
    await h.dispatch("message", { source: h.clients[0], data: { type: "BINDERY_ACTIVATE_ON_RELOAD" } });
    expect(h.clients[0].postMessage).toHaveBeenCalledWith({ type: "BINDERY_UPDATE_RELOADING" });
    expect(h.skipWaiting).toHaveBeenCalledTimes(1);
  });
});

describe.runIf(built)("production PWA static headers (actual handler, no sockets)", () => {
  it("serves a JSON manifest, root SW, offline page and every icon with correct public MIME types", async () => {
    // Native require bypasses Vite's transformation of the handler's `file:`-relative dist import.
    const { createProductionHandler } = createRequire(import.meta.url)(resolve("scripts/production-handler.mjs")) as {
      createProductionHandler: () => Promise<((request: Request) => Promise<Response>) & { shutdown(options?: unknown): Promise<void> }>;
    };
    const handler = await createProductionHandler();
    try {
      for (const [path, type] of [["/manifest.json", "application/json"], ["/sw.js", "text/javascript"], ["/offline.html", "text/html"], ...manifest.icons.map(icon => [icon.src, icon.type])]) {
        const response = await handler(new Request(scope + path.slice(1)));
        expect(response.status, path).toBe(200);
        expect(response.headers.get("content-type"), path).toContain(type);
        expect(response.headers.has("service-worker-allowed")).toBe(false);
        if (path === "/manifest.json") expect(await response.json()).toEqual(manifest);
        else expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
      }
    } finally { await handler.shutdown(); }
  });
});
