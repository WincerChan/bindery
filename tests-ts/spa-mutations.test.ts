import { afterAll, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { createServerFn } from "@tanstack/solid-start";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryStorage, saveBook as persistBook } from "../src/server/storage";
import { BinderyDatabase } from "../src/server/db";
import { bookFromDict, metadataFromDict } from "../src/core/models";

const mocks = vi.hoisted(() => ({ auth: {}, saveTheme: vi.fn(), deleteTemplate: vi.fn() }));
vi.mock("../src/server/functions", () => ({ authenticated: mocks.auth }));
vi.mock("../src/server/catalog/templates", () => ({ saveTheme: mocks.saveTheme, deleteTemplate: mocks.deleteTemplate }));
vi.mock("@tanstack/solid-start", () => ({
  createStart: (getOptions: () => unknown) => ({ getOptions }),
  createServerFn: () => ({
    middlewares: [] as unknown[],
    middleware(middlewares: unknown[]) { this.middlewares = middlewares; return this; },
    validator(validator: (data: unknown) => unknown) { return { handler: (handler: unknown) => ({ middlewares: this.middlewares, validator, handler }) }; },
  }),
}));
import { startInstance } from "../src/start";
import { checkTracker, deleteTracker, removeTemplate, saveTemplate, saveTracker, testTemplate } from "../src/features/catalog/mutations";
import { mutateBook, saveBook } from "../src/features/books/mutations";
import { mutateLibrarySelection } from "../src/features/library/mutations";
import { cleanupInvalidJobs, retryJob } from "../src/features/ingest/mutations";

type Boundary = { middlewares: unknown[]; validator(data: unknown): unknown; handler(input: { context: { library: LibraryStorage }; data: unknown }): Promise<unknown> };
const boundary = (fn: unknown) => fn as Boundary;
const root = mkdtempSync(join(tmpdir(), "bindery-spa-mutations-"));
let library: LibraryStorage, sequence = 0;
beforeEach(() => {
  vi.clearAllMocks(); const dir = join(root, String(sequence++));
  library = new LibraryStorage(join(dir, "library"), new BinderyDatabase(join(dir, "data.db"))); library.ensure();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
async function invoke(fn: unknown, data: unknown) { const f = boundary(fn); return f.handler({ context: { library }, data: f.validator(data) }); }
const form = (fields: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(fields)) data.set(key, value); return data; };

describe("SPA server-function boundaries", () => {
  it("registers global authentication, retains existing local guards and rejects malformed runtime inputs", async () => {
    expect((await startInstance.getOptions()).functionMiddleware).toEqual([mocks.auth]);
    type GlobalContext = ReturnType<typeof createServerFn>["~types"]["allServerContext"];
    expectTypeOf<GlobalContext["library"]>().toEqualTypeOf<LibraryStorage>();
    // This production mutation deliberately relies on the global guard; the
    // compiled entry test exercises it without a per-function middleware.
    expect(boundary(saveTracker).middlewares).toEqual([]);
    for (const fn of [deleteTracker, checkTracker, removeTemplate, saveTemplate, testTemplate, mutateBook, saveBook, mutateLibrarySelection, cleanupInvalidJobs, retryJob]) expect(boundary(fn).middlewares).toEqual([mocks.auth]);
    expect(() => boundary(saveTracker).validator({ id: "../escape", fields: {} })).toThrow("ID");
    expect(() => boundary(saveTracker).validator({ fields: { title: 1 } })).toThrow("表单");
    expect(() => boundary(saveTemplate).validator({ kind: "rules", id: "../escape", raw: "{}" })).toThrow("ID");
    expect(() => boundary(saveTemplate).validator({ kind: "unknown", id: "default", raw: "{}" })).toThrow("类型");
    expect(() => boundary(mutateBook).validator(form({ book_id: "a".repeat(32), action: "unknown" }))).toThrow("类型");
    expect(() => boundary(saveBook).validator({ book_id: "a".repeat(32) })).toThrow("表单");
  });
  it("creates, updates, checks and deletes tracker records through existing services with safe return targets", async () => {
    expect(await invoke(saveTracker, { fields: { title: "新书", author: "作者", next: "/wishlist?q=新书" } })).toEqual({ target: "/wishlist?q=新书" });
    const wish = library.db.listWishes()[0]!;
    await invoke(saveTracker, { id: wish.id, fields: { title: "改名", read_status: "read", next: "https://evil.test" } });
    expect(library.db.getWish(wish.id)).toMatchObject({ title: "改名", read: true });
    expect(await invoke(checkTracker, { title: "改名", author: "" })).toMatchObject({ exists: true });
    expect(await invoke(deleteTracker, { id: wish.id, next: "//evil.test" })).toEqual({ target: "/tracker" });
    expect(library.db.listWishes()).toEqual([]);
    await expect(invoke(saveTracker, { fields: { title: "" } })).rejects.toThrow("书名不能为空");
  });
  it("marks a book read without returning a Response and rejects missing books before side effects", async () => {
    const id = "a".repeat(32);
    persistBook(bookFromDict({ title: "书" }), library.base, id);
    library.saveMetadata(metadataFromDict({ book_id: id, title: "书" }));
    expect(await invoke(mutateBook, form({ book_id: id, action: "read", read: "1" }))).toEqual({ target: null });
    expect(library.db.getWishByLibraryBookId(id)).toMatchObject({ read: true });
    await expect(invoke(mutateBook, form({ book_id: "b".repeat(32), action: "read", read: "1" }))).rejects.toMatchObject({ status: 404 });
  });
  it("validates library/job mutation inputs before side effects", () => {
    for (const data of [{ action: "unknown", ids: [] }, { action: "archive", ids: [] }, { action: "delete", ids: ["../escape"] }, { action: "restore", ids: "all" }]) expect(() => boundary(mutateLibrarySelection).validator(data)).toThrow();
    expect(() => boundary(retryJob).validator("../escape")).toThrow("ID");
    expect(() => boundary(cleanupInvalidJobs).validator("unknown")).toThrow("分组");
  });
  it("archives/restores/deletes selections via existing storage semantics and reports restore conflicts", async () => {
    const ids = ["a".repeat(32), "b".repeat(32)];
    for (const id of ids) { persistBook(bookFromDict({ title: id }), library.base, id); library.saveMetadata(metadataFromDict({ book_id: id, title: id })); }
    expect(await invoke(mutateLibrarySelection, { action: "archive", ids: [...ids, ids[0]] })).toBe(2);
    expect(library.listBooks()).toHaveLength(0); expect(library.listArchivedBooks()).toHaveLength(2);
    mkdirSync(join(library.base, ids[1]!));
    await expect(invoke(mutateLibrarySelection, { action: "restore", ids })).rejects.toMatchObject({ status: 409 });
    expect(library.listArchivedBooks()).toHaveLength(2); // atomic preflight, no partial restore
    rmSync(join(library.base, ids[1]!), { recursive: true });
    expect(await invoke(mutateLibrarySelection, { action: "restore", ids: [ids[0]] })).toBe(1);
    expect(library.listBooks()).toHaveLength(1); expect(library.listArchivedBooks()).toHaveLength(1);
    expect(await invoke(mutateLibrarySelection, { action: "delete", ids })).toBe(1);
    expect(existsSync(join(library.base, ids[0]!))).toBe(true); expect(existsSync(join(library.base, "archive", ids[1]!))).toBe(false);
  });
  it("queues retry and cleans invalid history without returning a redirect Response", async () => {
    const id = "a".repeat(32), job = "b".repeat(32), invalid = "c".repeat(32);
    persistBook(bookFromDict({ title: "重试" }), library.base, id); library.saveMetadata(metadataFromDict({ book_id: id, title: "重试", source_type: "txt" }));
    for (const [jobId, bookId] of [[job, id], [invalid, null]]) library.db.createJob({ id: jobId!, book_id: bookId!, action: "regenerate", status: "failed", stage: "失败", message: null, log: null, rule_template: "default", created_at: "2026", updated_at: "2026" });
    expect(await invoke(retryJob, job)).toEqual({ retried: true });
    expect(library.db.listJobs().some(value => value.action === "retry" && value.book_id === id)).toBe(true);
    expect(await invoke(cleanupInvalidJobs, "failed")).toEqual({ cleaned: true });
    expect(library.db.getJob(invalid)).toBeNull(); expect(library.db.getJob(job)).not.toBeNull();
    await expect(invoke(retryJob, "f".repeat(32))).rejects.toMatchObject({ status: 404 });
  });
  it("reuses template save validation and turns referenced-template failures into mutation errors", async () => {
    mocks.saveTheme.mockReturnValue({ raw: "bad css", error: "主题 CSS 校验失败", saved: false });
    expect(await invoke(saveTemplate, { kind: "themes", id: "theme-a", raw: "bad css" })).toMatchObject({ saved: false, error: "主题 CSS 校验失败" });
    expect(mocks.saveTheme).toHaveBeenCalledWith("theme-a", "bad css");
    mocks.deleteTemplate.mockReturnValue("/rules?error=" + encodeURIComponent("模板已被书籍引用，无法删除"));
    await expect(invoke(removeTemplate, { kind: "themes", id: "theme-a" })).rejects.toThrow("模板已被书籍引用");
  });
});
