import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { hash } from "@node-rs/argon2";
import { createProductionHandler } from "../../../scripts/production-handler.mjs";

const root = await mkdtemp(join(tmpdir(), "bindery-spa-rpc-"));
let handler, db;
try {
  for (const key of ["BINDERY_LIBRARY_DIR", "BINDERY_DB_PATH", "BINDERY_PASSWORD_HASH", "BINDERY_TEMPLATE_DIR", "BINDERY_RULES_DIR", "BINDERY_THEMES_DIR", "BINDERY_PUBLIC_ORIGIN", "BINDERY_WEBAUTHN_RP_ID"]) { delete process.env[key]; delete process.env[key + "_FILE"]; }
  Object.assign(process.env, { BINDERY_LIBRARY_DIR: join(root, "library"), BINDERY_DB_PATH: join(root, "data.db"), BINDERY_TEMPLATE_DIR: join(root, "templates"), BINDERY_PASSWORD_HASH: await hash("spa-password", { memoryCost: 8192, timeCost: 1 }) });
  handler = await createProductionHandler();
  const login = await handler(new Request("http://localhost/login", { method: "POST", body: new URLSearchParams({ password: "spa-password" }) }));
  const cookie = login.headers.getSetCookie()[0].split(";", 1)[0];
  const dir = new URL("../../../dist/server/", import.meta.url);
  const manifest = (await Promise.all((await readdir(dir)).filter(n => n.includes("server-fn-resolver")).map(n => readFile(new URL(n, dir), "utf8")))).join("\n");
  function rpcPath(name) {
    const id = new RegExp('"([a-f0-9]{64})":\\s*\\{\\s*functionName: "' + name + '_createServerFn_handler"').exec(manifest)?.[1];
    assert.ok(id, name); return "/_serverFn/data/" + id;
  }
  async function rpc(name, data, extraCookie = "") {
    const form = data instanceof FormData;
    const path = rpcPath(name) + (form ? "?args=" + encodeURIComponent(JSON.stringify([{ method: "POST", context: {} }])) : "");
    const response = await handler(new Request("http://localhost" + path, { method: "POST", headers: { Cookie: cookie + extraCookie, Origin: "http://localhost", "Sec-Fetch-Site": "same-origin", "X-Server-Function-Format": form ? "2" : "8", ...(form ? {} : { "Content-Type": "application/json" }) }, body: form ? data : JSON.stringify([{ method: "POST", context: {}, data }]) }));
    const text = await response.text();
    assert.equal(response.status, 200, name + ": " + text + " " + JSON.stringify(Object.fromEntries(response.headers)));
    const payload = JSON.parse(text);
    return { response, result: payload.result };
  }
  const created = await rpc("saveTracker", { fields: { title: "编译后的写操作", next: "//evil.test" } });
  assert.equal(created.result.target, "/tracker");
  db = new DatabaseSync(process.env.BINDERY_DB_PATH);
  const wish = db.prepare("SELECT id FROM wishlist WHERE title = ?").get("编译后的写操作"); assert.ok(wish);
  await rpc("saveTracker", { id: wish.id, fields: { title: "已修改", read_status: "read" } });
  assert.equal(db.prepare("SELECT title FROM wishlist WHERE id = ?").get(wish.id).title, "已修改");
  await rpc("deleteTracker", { id: wish.id, next: "/tracker?q=done" });
  assert.equal(db.prepare("SELECT count(*) AS n FROM wishlist").get().n, 0);
  const bookId = "a".repeat(32); db.prepare("INSERT INTO books(book_id,title) VALUES (?, 'RPC 书籍')").run(bookId);
  await mkdir(join(root, "library", bookId), { recursive: true }); await writeFile(join(root, "library", bookId, "book.epub"), "fixture");
  const bookForm = new FormData(); bookForm.set("book_id", bookId); bookForm.set("action", "read"); bookForm.set("read", "true");
  assert.equal((await rpc("mutateBook", bookForm)).result.target, null);
  assert.equal(db.prepare("SELECT read FROM books WHERE book_id = ?").get(bookId).read, 1);
  const security = (path, body = {}, extraCookie = "") => handler(new Request("http://localhost/security/" + path, {
    method: "POST", headers: { Cookie: cookie + extraCookie, "Content-Type": "application/json", "HX-Request": "true" }, body: JSON.stringify(body), redirect: "manual",
  }));
  const options = await security("passkeys/register/options");
  assert.equal(options.status, 200); assert.ok((await options.json()).challenge);
  const challenge = options.headers.getSetCookie().find(value => value.startsWith("bindery_webauthn="));
  assert.match(challenge, /^bindery_webauthn=[^;]+; Max-Age=300; Path=\/security\/passkeys; HttpOnly; SameSite=Strict$/);
  const verify = await security("passkeys/register/verify", { credential: {} }, "; " + challenge.split(";", 1)[0]);
  assert.equal(verify.status, 400); assert.equal((await verify.json()).error, "通行密钥验证失败");
  assert.equal(verify.headers.getSetCookie()[0], "bindery_webauthn=; Max-Age=0; Path=/security/passkeys; HttpOnly; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  db.prepare("UPDATE sessions SET password_verified_at = NULL").run();
  assert.equal((await (await security("passkeys/register/options")).json()).error, "needs_password");
  assert.equal((await (await security("reauth", { password: "wrong" })).json()).error, "密码错误");
  assert.equal((await (await security("reauth", { password: "spa-password" })).json()).ok, true);
  db.prepare("INSERT INTO passkeys(credential_id,public_key,name,created_at) VALUES ('spa-key', ?, '旧名称', ?)").run(Buffer.from([1]), new Date().toISOString());
  assert.equal((await (await security("passkeys/spa-key/rename", { name: "新名称" })).json()).ok, true);
  assert.equal(db.prepare("SELECT name FROM passkeys WHERE credential_id = 'spa-key'").get().name, "新名称");
  const deleted = await security("passkeys/spa-key/delete");
  assert.equal(deleted.status, 303); assert.match(deleted.headers.get("Location"), /^\/security\?toast=/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM passkeys").get().n, 0);
  const expired = await handler(new Request("http://localhost/security/passkeys/spa-key/delete", { method: "POST", headers: { "HX-Request": "true" } }));
  assert.equal(expired.status, 401); assert.match(expired.headers.get("HX-Redirect"), /^\/login\?next=/);
  bookForm.set("read", "false");
  const anonymous = await handler(new Request("http://localhost" + rpcPath("mutateBook") + "?args=" + encodeURIComponent(JSON.stringify([{ method: "POST", context: {} }])), {
    method: "POST", headers: { Origin: "http://localhost", "X-Server-Function-Format": "2" }, body: bookForm,
  }));
  assert.equal(anonymous.status, 200); assert.ok(anonymous.headers.get("X-Server-Function-Format"));
  const denied = await anonymous.json();
  assert.equal(denied.error.isSerializedRedirect, true); assert.equal(denied.error.href, "/login?next=%2F");
  assert.equal(db.prepare("SELECT read FROM books WHERE book_id = ?").get(bookId).read, 1);
  console.log("Compiled SPA RPC checks passed: tracker CRUD, FormData book write, auth, original WebAuthn endpoints and unchanged cookie attributes");
} finally {
  db?.close(); try { await handler?.shutdown(); } finally { await rm(root, { recursive: true, force: true }); }
}
