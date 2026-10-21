export type Strategy = "network-only" | "network-first" | "cache-first";
export type PwaRequest = Pick<Request, "url" | "method" | "mode" | "headers">;

const hashedAsset = /^assets\/(?:[\w.-]+\/)*[\w.-]+-[\w-]{8,}\.(?:js|mjs|css|wasm|png|svg|jpg|jpeg|webp|avif|woff2?)$/;
const wasmAsset = /^assets\/(?:[\w.-]+\/)*[\w.-]+\.wasm$/;

export function isBuildAsset(path: string): boolean {
  return hashedAsset.test(path) || wasmAsset.test(path);
}

/** A positive static allowlist. All dynamic requests, including RPC, bypass the SW. */
export function requestStrategy(request: PwaRequest, scope: string, precache: readonly string[] = []): Strategy {
  const base = new URL(scope), url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== base.origin || !url.pathname.startsWith(base.pathname)
    || request.headers.has("range") || request.headers.has("authorization")) return "network-only";
  const path = url.pathname.slice(base.pathname.length);
  // Encoded path aliases and queries must never turn private responses into static assets.
  if (/%|\\/.test(path)) return "network-only";
  if (/^(?:api|_serverFn)(?:\/|$)/.test(path)
    || /^book\/[^/]+\/(?:epub|cover|download)(?:\/|$)/.test(path)
    || /(?:^|\/)(?:covers?|downloads?)(?:\/|$)/.test(path)
    || /\.(?:epub|kfx|azw3?)(?:\/|$)/i.test(path)) return "network-only";
  if (request.mode === "navigate") return "network-first";
  if (url.search) return "network-only";
  // WASM imported via Vite's ?url can be emitted by a separate Worker build.
  if (isBuildAsset(path)
    || precache.includes(path) && /^(?:manifest\.json|offline\.html|favicon\.svg|logo\.svg|icons\/[\w.-]+\.png)$/.test(path)) return "cache-first";
  return "network-only";
}

export function canCacheResponse(request: PwaRequest, response: Response, scope: string, precache: readonly string[]): boolean {
  if (requestStrategy(request, scope, precache) !== "cache-first" || response.status !== 200
    || response.redirected || !["basic", "default"].includes(response.type)
    || /(?:no-store|private)/i.test(response.headers.get("cache-control") || "")) return false;
  const extension = new URL(request.url).pathname.split(".").at(-1);
  const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const types: Record<string, string[]> = {
    js: ["text/javascript", "application/javascript"], mjs: ["text/javascript", "application/javascript"],
    css: ["text/css"], wasm: ["application/wasm"], html: ["text/html"],
    json: ["application/json", "application/manifest+json"], svg: ["image/svg+xml"], png: ["image/png"],
    jpg: ["image/jpeg"], jpeg: ["image/jpeg"], webp: ["image/webp"], avif: ["image/avif"],
    woff: ["font/woff"], woff2: ["font/woff2"],
  };
  return !!extension && !!mime && !!types[extension]?.includes(mime);
}

export function cachePrefix(scope: string): string {
  return `bindery-pwa:${encodeURIComponent(new URL(scope).pathname)}:`;
}

export function outdatedCaches(names: readonly string[], current: string, scope: string): string[] {
  return names.filter(name => name.startsWith(cachePrefix(scope)) && name !== current);
}
