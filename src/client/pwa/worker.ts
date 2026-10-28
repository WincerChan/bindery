/// <reference lib="webworker" />
import { cachePrefix, canCacheResponse, outdatedCaches, requestStrategy } from "./policy";

declare const __PWA_BUILD__: { version: string; precache: string[] };
const worker = globalThis as unknown as ServiceWorkerGlobalScope;
const { version, precache } = __PWA_BUILD__;
const scope = worker.registration.scope;
const cacheName = cachePrefix(scope) + version;
const absolute = (path: string) => new URL(path, scope).href;
const precacheConcurrency = 4;

worker.addEventListener("install", event => {
  event.waitUntil((async () => {
    try {
      const cache = await worker.caches.open(cacheName);
      // Validate every response: an auth redirect or HTML error must fail installation.
      // Keep the install from competing with the page for every connection at once.
      // Drain active downloads before deleting a failed generation's partial cache.
      let next = 0, failure: Error | undefined;
      await Promise.all(Array.from({ length: Math.min(precacheConcurrency, precache.length) }, async () => {
        while (!failure && next < precache.length) {
          const path = precache[next++];
          try {
            const request = new Request(absolute(path), { credentials: "omit", cache: "reload", redirect: "error" });
            const response = await fetch(request);
            if (!canCacheResponse(request, response, scope, precache)) throw new Error(`Invalid PWA asset: ${path}`);
            await cache.put(request, response);
          } catch (error) {
            failure ??= new Error(`Failed to precache ${absolute(path)}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          }
        }
      }));
      if (failure) throw failure;
    } catch (error) {
      await worker.caches.delete(cacheName);
      throw error;
    }
    // A replacement worker waits until a deliberate reload or all tabs close.
  })());
});

worker.addEventListener("activate", event => {
  event.waitUntil((async () => {
    await Promise.all(outdatedCaches(await worker.caches.keys(), cacheName, scope).map(name => worker.caches.delete(name)));
    // No clients.claim(): the first install takes control on the next navigation.
  })());
});

worker.addEventListener("message", event => {
  if (event.data?.type !== "BINDERY_ACTIVATE_ON_RELOAD" || !event.source || !("url" in event.source)) return;
  const source = event.source;
  event.waitUntil((async () => {
    const clients = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Another open tab may be converting/writing a book. Keep waiting in that case.
    if (clients.length === 1 && clients[0].id === source.id && source.url.startsWith(scope)) {
      source.postMessage({ type: "BINDERY_UPDATE_RELOADING" });
      await worker.skipWaiting();
    }
  })());
});

worker.addEventListener("fetch", event => {
  const strategy = requestStrategy(event.request, scope, precache);
  if (strategy === "network-only") return;
  if (strategy === "network-first") {
    event.respondWith((async () => {
      try {
        // Pass through redirects (including 303), errors and streaming SSR unchanged.
        return await fetch(event.request);
      } catch {
        const cache = await worker.caches.open(cacheName);
        return await cache.match(absolute("offline.html"))
          ?? new Response("当前离线。书库需要连接服务器，请联网后刷新。", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
      }
    })());
    return;
  }
  event.respondWith((async () => {
    const cache = await worker.caches.open(cacheName);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (canCacheResponse(event.request, response, scope, precache)) {
      event.waitUntil(cache.put(event.request, response.clone()).catch(() => undefined));
    }
    return response;
  })());
});
