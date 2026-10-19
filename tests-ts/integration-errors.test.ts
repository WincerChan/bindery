import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadOrNotFound } from "../src/shared/not-found";
import { missingDetails, type MissingEntity } from "../src/shared/entities";
import { authenticatedRoute, HttpError, requireBook, requireEntity } from "../src/server/http";
import { ruleEditor, themeEditor } from "../src/server/catalog/templates";
import { writeTracker } from "../src/server/catalog/tracker";
import { regenerateBook } from "../src/server/ingest/actions";
import { signIn } from "../src/server/auth";
import { temporaryLibrary } from "./fixtures/library/support";
vi.mock("@tanstack/solid-router", () => ({ notFound: (options: object) => ({ ...options, isNotFound: true }) }));
let env: ReturnType<typeof temporaryLibrary>;
beforeEach(() => { env = temporaryLibrary(); vi.stubEnv("BINDERY_TEMPLATE_DIR", join(env.root, "templates")); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(env.root, { recursive: true, force: true }); });
describe("shared entity 404 boundaries", () => {
  const missing: Record<MissingEntity, () => unknown> = {
    book: () => requireBook("a".repeat(32), env.library),
    rule: () => ruleEditor("missing"), theme: () => themeEditor("missing"),
    job: () => regenerateBook(env.library, "", new FormData(), "missing"),
    wish: () => writeTracker(env.library, {}, "f".repeat(32)),
  };
  it.each(Object.keys(missing) as MissingEntity[])("maps missing %s through the same loader and authenticated HTTP boundary", async kind => {
    const fn = missing[kind];
    expect(fn).toThrow(missingDetails[kind]);
    await expect(loadOrNotFound(fn)).rejects.toMatchObject({ isNotFound: true, data: missingDetails[kind] });
    const handler = authenticatedRoute(async () => { fn(); return Response.json({ unexpected: true }); }, () => env.library);
    const response = await handler({ request: new Request("http://localhost/", { headers: { Cookie: `bindery_session=${signIn(env.library.db)}` } }), params: {} });
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ detail: missingDetails[kind] });
  });
  it("preserves unrelated errors, authentication responses and successful values", async () => {
    expect(requireEntity(0, "job")).toBe(0); expect(requireEntity("", "job")).toBe("");
    expect(await loadOrNotFound(() => 42)).toBe(42);
    const error = new HttpError(409, "冲突"); await expect(loadOrNotFound(() => { throw error; })).rejects.toBe(error);
    const response = new Response(null, { status: 303, headers: { Location: "/login" } }); await expect(loadOrNotFound(() => { throw response; })).rejects.toBe(response);
  });
});
