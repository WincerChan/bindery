import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hash } from "@node-rs/argon2";
import { zipSync, unzipSync, strToU8 } from "fflate";
import { createProductionHandler } from "../../../scripts/production-handler.mjs";

const root = await mkdtemp(join(tmpdir(), "bindery-library-production-"));
let handler, db;
try {
  for (const name of ["BINDERY_DB_PATH", "BINDERY_LIBRARY_DIR", "BINDERY_TEMPLATE_DIR", "BINDERY_RULES_DIR", "BINDERY_THEMES_DIR", "BINDERY_PASSWORD_HASH", "BINDERY_PUBLIC_ORIGIN"]) {
    process.env[name] = ""; process.env[`${name}_FILE`] = "";
  }
  process.env.BINDERY_LIBRARY_DIR = join(root, "library"); process.env.BINDERY_DB_PATH = join(root, "library", "bindery.db");
  process.env.BINDERY_TEMPLATE_DIR = join(root, "templates"); process.env.BINDERY_PASSWORD_HASH = await hash("library-password", { memoryCost: 8192, timeCost: 1 });
  handler = await createProductionHandler();
  let cookie = "";
  const get = path => handler(new Request("http://localhost" + path, { headers: { Cookie: cookie } }));
  const post = (path, body) => handler(new Request("http://localhost" + path, { method: "POST", body, headers: { Cookie: cookie, Origin: "http://localhost", "Sec-Fetch-Site": "same-origin" } }));
  for (const path of ["/", "/archive", "/library"]) assert.equal((await get(path)).status, 303, path);
  for (const path of ["/books/archive", "/archive/delete-bulk", "/books/download"]) assert.equal((await post(path, new URLSearchParams())).status, 303, path);
  const login = await post("/login", new URLSearchParams({ password: "library-password", next: "/" }));
  cookie = login.headers.getSetCookie()[0].split(";", 1)[0];
  db = new DatabaseSync(process.env.BINDERY_DB_PATH, { timeout: 5000 });
  const a = "a".repeat(32), b = "b".repeat(32);
  for (const id of [a, b]) {
    db.prepare("INSERT INTO books(book_id,title,author,source_type,theme_template,updated_at) VALUES (?, '长安的荔枝', '马伯庸', 'epub', '__book__', '2026-10-19')").run(id);
    await mkdir(join(process.env.BINDERY_LIBRARY_DIR, id), { recursive: true });
    await writeFile(join(process.env.BINDERY_LIBRARY_DIR, id, "book.epub"), zipSync({ mimetype: strToU8("application/epub+zip") }));
  }
  const home = await get("/?q=长安&read_filter=unread"); assert.equal(home.status, 200);
  const html = await home.text(); assert.match(html, /data-pagination-total/); assert.match(html, /长安的荔枝/); assert.match(html, /return_to=/); assert.doesNotMatch(html, /书库共有/);
  const partial = await get("/library?q=长安&page=2&per_page=4"); assert.equal(partial.status, 200); assert.equal(partial.headers.get("cache-control"), "no-store");
  const fragment = await partial.text(); assert.match(fragment, /id="library-section"/); assert.doesNotMatch(fragment, /<main|<html/); assert.match(fragment, /data-page="1"/);
  const invalidPage = await get("/library?page=oops"); assert.equal(invalidPage.status, 422); assert.deepEqual(await invalidPage.json(), { detail: "分页参数必须为整数" });
  assert.equal((await get("/?per_page=oops")).status, 422);
  const bundle = await post("/books/download", new URLSearchParams([["book_ids", a], ["book_ids", b], ["book_ids", a]]));
  assert.equal(bundle.status, 200); assert.equal(bundle.headers.get("content-type"), "application/zip");
  assert.deepEqual(Object.keys(unzipSync(new Uint8Array(await bundle.arrayBuffer()))), ["长安的荔枝-马伯庸.epub", "长安的荔枝-马伯庸-2.epub"]);
  const empty = await post("/books/download", new URLSearchParams()); assert.equal(empty.status, 400); assert.deepEqual(await empty.json(), { detail: "未选择书籍" });
  const archived = await post("/books/archive", new URLSearchParams([["book_ids", a], ["book_ids", "bad-id"], ["next", "//evil.invalid"]]));
  assert.equal(archived.status, 303); assert.equal(archived.headers.get("location"), "/"); assert.equal(db.prepare("SELECT archived FROM books WHERE book_id = ?").get(a).archived, 1);
  const legacyArchive = await get("/archive"); assert.equal(legacyArchive.status, 303); assert.equal(legacyArchive.headers.get("location"), "/?scope=archived");
  const archive = await get("/?scope=archived"); assert.equal(archive.status, 200); const archiveHtml = await archive.text(); assert.match(archiveHtml, /data-bulk-mode-toggle/); assert.match(archiveHtml, /library-native-actions/); assert.match(archiveHtml, />恢复</); assert.doesNotMatch(archiveHtml, /data-read-filter-toggle|data-book-detail-link|\/books\/download/);
  const deleted = await post("/archive/delete-bulk", new URLSearchParams([["book_ids", a], ["book_ids", b]]));
  assert.equal(deleted.status, 303); assert.equal(deleted.headers.get("location"), "/?scope=archived"); assert.equal(db.prepare("SELECT COUNT(*) AS n FROM books WHERE book_id = ?").get(a).n, 0); assert.equal(db.prepare("SELECT archived FROM books WHERE book_id = ?").get(b).archived, 0);
  for (const [next, expected] of [["/?scope=archived&q=Alpha&page=2#books", "/?scope=archived&q=Alpha&page=2"], ["https://evil.invalid/", "/?scope=archived"], ["//evil.invalid/", "/?scope=archived"], ["", "/?scope=archived"]]) {
    const id = "c".repeat(32);
    db.prepare("INSERT INTO books(book_id,title,archived) VALUES (?, '跳转测试', 1)").run(id);
    await mkdir(join(process.env.BINDERY_LIBRARY_DIR, "archive", id), { recursive: true });
    await writeFile(join(process.env.BINDERY_LIBRARY_DIR, "archive", id, "book.epub"), zipSync({ mimetype: strToU8("application/epub+zip") }));
    const restored = await post(`/book/${id}/restore`, new URLSearchParams({ next }));
    assert.equal(restored.status, 303); assert.equal(restored.headers.get("location"), expected);
    await post(`/book/${id}/archive`, new URLSearchParams());
    const removed = await post(`/book/${id}/delete`, new URLSearchParams({ next }));
    assert.equal(removed.status, 303); assert.equal(removed.headers.get("location"), expected);
  }
  const serverDir = new URL("../../../dist/server/", import.meta.url);
  const manifest = (await Promise.all((await readdir(serverDir)).filter(name => name.includes("server-fn-resolver")).map(name => readFile(new URL(name, serverDir), "utf8")))).join("\n");
  const id = /"([a-f0-9]{64})":\s*\{\s*functionName: "loadLibrary_createServerFn_handler"/.exec(manifest)?.[1]; assert.ok(id, "library RPC manifest");
  const rpcPath = `/_serverFn/data/${id}?args=${encodeURIComponent(JSON.stringify([{ data: { q: "长安", sort: "updated", page: 1, read_filter: "all", per_page: 24 }, context: {} }]))}`;
  const rpc = await handler(new Request("http://localhost" + rpcPath, { headers: { Cookie: cookie, Origin: "http://localhost", "Sec-Fetch-Site": "same-origin" } }));
  assert.equal(rpc.status, 200); const payload = await rpc.json(); assert.equal(payload.result.total_books, 1); assert.equal(payload.result.books[0].book_id, b);
  db.close();
} finally {
  if (db?.isOpen) db.close();
  try { await handler?.shutdown(); }
  finally { await rm(root, { recursive: true, force: true }); }
}
