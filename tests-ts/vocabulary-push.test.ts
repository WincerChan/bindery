import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { lexTraceSettings, lexTraceSettingsView, normalizeLexiTraceBaseUrl, saveLexiTraceSettings, testLexiTraceConnection } from "../src/server/vocabulary/settings";
import { pushVocabulary, retryVocabularyPush, vocabularyPushPayload } from "../src/server/vocabulary/push";
import { syncVocabulary } from "../src/server/vocabulary/sync";
import { createBook, temporaryLibrary } from "./fixtures/library/support";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
const device = { id: "paperwhite", kind: "kindle" as const, name: "Paperwhite" };
const bookId = (value: string) => value.repeat(32).slice(0, 32);
const at = (minute: number) => new Date(Date.UTC(2026, 9, 23, 16, minute)).toISOString();
const word = (raw: string, minute: number, patch: Record<string, unknown> = {}) => ({
  lookup_id: `lookup-${minute}`, raw_word: raw, word: raw, lang: "en", book_id: null, source_title: "Book", looked_up_at: at(minute),
  context: { sentence: "A sentence with the word.", previous: ["Before."], following: ["After."] }, ...patch,
});
function configured(overrides: Record<string, unknown> = {}) {
  const value = temporaryLibrary();
  saveLexiTraceSettings(value.library.db, { baseUrl: "https://lexi.example", token: "secret-token", enabled: true });
  Object.assign(value.library.db, overrides);
  return value;
}
function addWords(library: ReturnType<typeof temporaryLibrary>["library"], words: ReturnType<typeof word>[]) {
  return syncVocabulary(library, { device, words });
}
const jsonResponse = (status: number, body = "{}") => new Response(body, { status, headers: { "Content-Type": "application/json" } });

describe("LexiTrace settings", () => {
  it("accepts HTTPS and HTTP loopback, rejecting unsafe URLs", () => {
    expect(normalizeLexiTraceBaseUrl("https://lexi.example/api/")).toBe("https://lexi.example/api");
    expect(normalizeLexiTraceBaseUrl("http://localhost:8080")).toBe("http://localhost:8080");
    expect(normalizeLexiTraceBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(normalizeLexiTraceBaseUrl("http://[::1]:8080/")).toBe("http://[::1]:8080");
    expect(normalizeLexiTraceBaseUrl("")).toBe("");
    for (const value of ["http://example.com", "https://user:pass@example.com", "https://example.com/?q=1", "https://example.com/#x", "ftp://localhost", "not a url"]) {
      expect(() => normalizeLexiTraceBaseUrl(value)).toThrow();
    }
  });

  it("never returns the token and retains it when an empty token is saved until explicitly cleared", () => {
    const { library } = temporaryLibrary(), db = library.db;
    const saved = saveLexiTraceSettings(db, { baseUrl: "https://lexi.example", token: "secret-token", enabled: true });
    expect(saved).toEqual({ baseUrl: "https://lexi.example", hasToken: true, enabled: true });
    expect(JSON.stringify(saved)).not.toContain("secret-token");
    expect(lexTraceSettings(db).token).toBe("secret-token");
    expect(saveLexiTraceSettings(db, { baseUrl: "https://lexi.example/", token: "", enabled: false })).toEqual({ baseUrl: "https://lexi.example", hasToken: true, enabled: false });
    expect(saveLexiTraceSettings(db, { clearToken: true }).hasToken).toBe(false);
    expect(lexTraceSettingsView(db).hasToken).toBe(false);
  });

  it("tests authorization against a fake LexiTrace server without exposing its body or token", async () => {
    let status = 404, authorization = "";
    const server = createServer((request, response) => { authorization = request.headers.authorization ?? ""; response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify({ detail: "secret-token must not leak" })); });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(), port = typeof address === "object" && address ? address.port : 0, base = `http://127.0.0.1:${port}`;
    const { library } = temporaryLibrary();
    saveLexiTraceSettings(library.db, { baseUrl: base, token: "secret-token", enabled: true });
    expect(await testLexiTraceConnection(library.db, {})).toMatchObject({ ok: true, status: 404 });
    expect(authorization).toBe("Bearer secret-token");
    status = 401;
    const denied = await testLexiTraceConnection(library.db, {});
    expect(denied).toMatchObject({ ok: false, category: "auth", status: 401 });
    expect(JSON.stringify(denied)).not.toContain("secret-token");
    status = 503;
    expect(await testLexiTraceConnection(library.db, {})).toMatchObject({ ok: false, category: "disabled", status: 503 });
    const empty = temporaryLibrary();
    expect(await testLexiTraceConnection(empty.library.db, {})).toMatchObject({ ok: false, category: "not_configured" });
    expect(() => normalizeLexiTraceBaseUrl("http://example.com")).toThrow();
  });
});

describe("LexiTrace push worker", () => {
  it("pushes all existing words oldest first with the minimal payload and sanitized source", async () => {
    const { library } = configured(), id = bookId("a");
    createBook(library, id, { title: "Book/With\\Slashes\nControl", author: "作者" });
    addWords(library, [
      word("second", 2, { book_id: id, source_title: "Ignored/Source" }),
      word("first", 1, { book_id: id, source_title: "Old/Title", context: { sentence: "x".repeat(32768), previous: [], following: [] } }),
    ]);
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const result = await pushVocabulary(library, { fetcher: async (url, init) => { requests.push({ url: String(url), init: init! }); return jsonResponse(202, '{"status":"queued"}'); } });
    expect(result).toEqual({ configured: true, attempted: 2, pushed: 2, conflicts: 0, errors: 0 });
    const bodies = requests.map(request => JSON.parse(String(request.init.body)));
    expect(bodies.map(body => body.source_text)).toEqual(["first", "second"]);
    expect(requests[0]!.url).toBe("https://lexi.example/api/integrations/llplayer/lookups");
    expect(requests[0]!.init.headers).toMatchObject({ Authorization: "Bearer secret-token", "Content-Type": "application/json" });
    expect(bodies[0]).toMatchObject({ lookup_id: expect.stringMatching(/^[0-9a-f-]{36}$/), source_text: "first", source: "Book With Slashes Control", looked_up_at: "2026-10-23T16:01:00.000Z", meta: { media_title: "Book/With\\Slashes Control" } });
    expect(bodies[0].context.sentence).toHaveLength(32768);
    expect(bodies[1]).toMatchObject({ source: "Book With Slashes Control", meta: { media_title: "Book/With\\Slashes Control" } });
    expect(library.db.listVocabulary().every(row => row.push_state === "pushed")).toBe(true);
  });

  it("keeps every request under the 256 KiB ingest limit", async () => {
    const { library } = configured();
    addWords(library, [word("large", 1, { context: { sentence: "𠀀".repeat(16384), previous: Array.from({ length: 32 }, () => "𠀀".repeat(4096)), following: Array.from({ length: 32 }, () => "𠀀".repeat(4096)) } })]);
    let body = "";
    const result = await pushVocabulary(library, { fetcher: async (_url, init) => { body = String(init!.body); return jsonResponse(202); } });
    expect(result).toMatchObject({ pushed: 1 });
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(256 * 1024);
    expect(JSON.parse(body).context.sentence.length).toBeGreaterThan(0);
  });

  it("clamps overlong words while keeping a stable lookup id on replay", async () => {
    const { library } = configured();
    addWords(library, [word("w".repeat(600), 1)]);
    const bodies: any[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => { bodies.push(JSON.parse(String(init!.body))); return jsonResponse(bodies.length === 1 ? 202 : 200, '{"status":"saved"}'); };
    await pushVocabulary(library, { fetcher });
    const row = library.db.listVocabulary()[0]!;
    library.db.resetVocabularyPush([row.id]);
    await pushVocabulary(library, { fetcher });
    expect(bodies[0].source_text).toHaveLength(512);
    expect(bodies[1].lookup_id).toBe(bodies[0].lookup_id);
    expect(library.db.getVocabulary(row.id)).toMatchObject({ push_state: "pushed" });
  });

  it("treats 409 as a conflict, 410 as permanently done, and never retries either", async () => {
    const { library } = configured();
    addWords(library, [word("conflict", 1), word("deleted", 2)]);
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => jsonResponse(JSON.parse(String(init!.body)).source_text === "conflict" ? 409 : 410);
    const result = await pushVocabulary(library, { fetcher });
    expect(result).toMatchObject({ attempted: 2, pushed: 1, conflicts: 1, errors: 0 });
    const rows = library.db.listVocabulary();
    expect(rows.find(row => row.word === "conflict")).toMatchObject({ push_state: "conflict" });
    expect(JSON.parse(rows.find(row => row.word === "conflict")!.push_status_json!)).toMatchObject({ http: 409, retryable: false });
    expect(rows.find(row => row.word === "deleted")).toMatchObject({ push_state: "pushed" });
    expect(JSON.parse(rows.find(row => row.word === "deleted")!.push_status_json!)).toMatchObject({ status: "deleted", http: 410 });
    expect(await pushVocabulary(library, { fetcher })).toEqual({ configured: true, attempted: 0, pushed: 0, conflicts: 0, errors: 0 });
  });

  it("backs off exponentially on 503 and stops at the attempt cap", async () => {
    const { library } = configured();
    addWords(library, [word("retry", 1)]);
    let clock = Date.UTC(2026, 9, 23, 17, 0), requests = 0;
    const delays: number[] = [];
    const result = await pushVocabulary(library, {
      maxAttempts: 3, waitForRetry: true, now: () => new Date(clock), sleep: async ms => { delays.push(ms); clock += ms; },
      fetcher: async () => { requests++; return jsonResponse(503); },
    });
    const row = library.db.listVocabulary()[0]!, status = JSON.parse(row.push_status_json!);
    expect(result).toMatchObject({ attempted: 3, errors: 3 });
    expect(requests).toBe(3); expect(delays).toEqual([5000, 10000]);
    expect(row).toMatchObject({ push_state: "error" });
    expect(status).toMatchObject({ http: 503, attempts: 3, retryable: false });
    expect(await pushVocabulary(library, { fetcher: async () => { requests++; return jsonResponse(202); } })).toMatchObject({ attempted: 0 });
    expect(requests).toBe(3);
  });

  it("does nothing while disabled or unconfigured and redacts tokens from errors", async () => {
    const { library } = configured();
    addWords(library, [word("disabled", 1)]);
    saveLexiTraceSettings(library.db, { enabled: false });
    let called = false;
    expect(await pushVocabulary(library, { fetcher: async () => { called = true; return jsonResponse(202); } })).toEqual({ configured: false, attempted: 0, pushed: 0, conflicts: 0, errors: 0 });
    expect(called).toBe(false);
    saveLexiTraceSettings(library.db, { enabled: true });
    const result = await pushVocabulary(library, { fetcher: async () => { throw new Error("secret-token network failure"); } });
    expect(result).toMatchObject({ configured: true, errors: 1 });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(library.db.listVocabulary()[0])).not.toContain("secret-token");
  });

  it("retries failed words on demand and resets their attempt budget", () => {
    const { library } = configured();
    addWords(library, [word("retry-me", 1)]);
    const row = library.db.listVocabulary()[0]!;
    library.db.updateVocabularyPush(row.id, "error", JSON.stringify({ status: "error", attempts: 5, retryable: false }), null, at(2));
    expect(retryVocabularyPush(library)).toBe(1);
    expect(library.db.getVocabulary(row.id)).toMatchObject({ push_state: "pending", push_status_json: null, pushed_at: null });
  });
});
