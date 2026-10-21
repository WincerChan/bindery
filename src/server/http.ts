import { cookies, redirect, AuthError } from "./auth-http";
import { isAuthenticated, SESSION_COOKIE } from "./auth";
import { getLibrary } from "./runtime";
import type { LibraryStorage } from "./storage";
import { withToast, type ToastKind } from "../shared/notifications";
import { missingDetails, type MissingEntity } from "../shared/entities";

export class HttpError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(detail);
    this.name = "HttpError";
  }
}
export function missingEntity(entity: MissingEntity): never {
  throw new HttpError(404, missingDetails[entity]);
}
export function requireEntity<T>(value: T | null | undefined | false, entity: MissingEntity): T {
  if (value === null || value === undefined || value === false) missingEntity(entity);
  return value;
}

export function requireAuth(request: Request, library = getLibrary()): LibraryStorage {
  if (!isAuthenticated(library.db, cookies(request)[SESSION_COOKIE])) {
    const location = `/login?next=${new URL(request.url).pathname}`;
    throw request.headers.get("HX-Request") === "true"
      ? new Response(null, { status: 401, headers: { "HX-Redirect": location } })
      : redirect(location);
  }
  return library;
}

export function requireBook(bookId: string, library = getLibrary()) {
  // Match the legacy implementation's public route boundary before passing IDs to filesystem APIs.
  if (!/^[a-f0-9]{32}$/.test(bookId) || !library.ensureBookExists(bookId)) {
    missingEntity("book");
  }
  return library.loadMetadata(bookId);
}

export function httpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof AuthError) return new HttpError(error.status, error.message);
  if (error instanceof Error && "status" in error) {
    if (error.status === 404 && error.message === "Book not found") return new HttpError(404, "书籍不存在");
    if (error.status === 409 && error.message === "Book exists") return new HttpError(409, "书籍已存在");
  }
  // Only expected filesystem/SQLite errors cross the HTTP boundary.
  const rawCode = (error as NodeJS.ErrnoException | null)?.code;
  const code = typeof rawCode === "string" ? rawCode : undefined;
  if (code === "ENOENT") return new HttpError(404, "资源不存在");
  if (code === "SQLITE_BUSY" || code === "ERR_SQLITE_ERROR" && /locked|busy/i.test(String(error))) {
    return new HttpError(503, "书库忙，请稍后重试");
  }
  if (code?.startsWith("SQLITE_CONSTRAINT") || code === "ERR_SQLITE_ERROR" && /constraint/i.test(String(error))) {
    return new HttpError(409, "数据冲突，请刷新后重试");
  }
  return new HttpError(500, "服务器内部错误");
}

export interface ApiContext<P> { request: Request; params: P; library: LibraryStorage }

/** Use inside file-route server.handlers. Authentication also runs at the entry. */
export function authenticatedRoute<P>(handler: (context: ApiContext<P>) => Response | Promise<Response>, libraryProvider = getLibrary) {
  return async (context: { request: Request; params: P }): Promise<Response> => {
    let response: Response;
    try {
      const library = requireAuth(context.request, libraryProvider());
      response = await handler({ ...context, library });
    } catch (error) {
      if (error instanceof Response) response = error;
      else {
        const mapped = httpError(error);
        if (mapped.status === 500) console.error(error);
        response = Response.json({ detail: mapped.detail }, { status: mapped.status });
      }
    }
    if (!response.headers.has("Cache-Control")) response.headers.set("Cache-Control", "no-store");
    return response;
  };
}

export const edgeRevalidateHeaders = () => ({
  "Cache-Control": "private, no-cache, must-revalidate",
  "CDN-Cache-Control": "no-store",
  "Cloudflare-CDN-Cache-Control": "no-store",
  Pragma: "no-cache",
});
export const coverCacheHeaders = () => ({
  "Cache-Control": "private, max-age=604800, immutable",
  "CDN-Cache-Control": "no-store",
  "Cloudflare-CDN-Cache-Control": "no-store",
});

export function redirectWithToast(target: string, message: string, kind: ToastKind = "success"): Response {
  return redirect(withToast(target, message, kind));
}
export function setToastHeader(response: Response, message: string, kind: ToastKind = "success"): void {
  // legacy json.dumps defaults to ensure_ascii=True; Fetch headers are ByteString.
  const payload = JSON.stringify({ "bindery:toast": { message, kind } })
    .replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  response.headers.set("HX-Trigger", payload);
}
