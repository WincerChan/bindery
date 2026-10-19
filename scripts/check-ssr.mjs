import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hash } from "@node-rs/argon2";
import { createProductionHandler } from "./production-handler.mjs";
const dir = await mkdtemp(join(tmpdir(), "bindery-ssr-"));
const names = ["BINDERY_DB_PATH", "BINDERY_LIBRARY_DIR", "BINDERY_PASSWORD_HASH", "BINDERY_PUBLIC_ORIGIN", "BINDERY_WEBAUTHN_RP_ID"];
const previous = Object.fromEntries(names.flatMap(name => [name, `${name}_FILE`]).map(name => [name, process.env[name]]));
try {
  for (const name of names) {
    process.env[name] = "";
    process.env[`${name}_FILE`] = "";
  }
  process.env.BINDERY_DB_PATH = join(dir, "fixture.db");
  process.env.BINDERY_LIBRARY_DIR = join(dir, "library");
  process.env.BINDERY_PASSWORD_HASH = await hash("ssr-password", {
    memoryCost: 8192,
    timeCost: 1
  });
  const handler = await createProductionHandler();
  const get = (path, cookie = "") => handler(new Request("http://localhost" + path, {
    headers: {
      Cookie: cookie
    }
  }));
  const protectedPage = await get("/");
  assert.equal(protectedPage.status, 303);
  assert.equal(protectedPage.headers.get("location"), "/login?next=/");
  const login = await get("/login?next=/?q=a:b");
  assert.equal(login.status, 200);
  const loginHtml = await login.text();
  assert.match(loginHtml, /name="password"/);
  assert.match(loginHtml, /name="next" value="\/\?q=a:b"/);
  assert.equal(login.headers.get("cache-control"), "no-store");
  const loginData = await get("/login/data?next=%2Fsecurity");
  assert.equal(loginData.status, 200);
  assert.deepEqual(await loginData.json(), {
    hash_configured: true,
    next: "/security",
    error: null,
    passkey_available: false
  });
  const bad = await handler(new Request("http://localhost/login", {
    method: "POST",
    body: new URLSearchParams({
      password: "wrong"
    })
  }));
  assert.equal(bad.status, 303);
  assert.match(bad.headers.get("location"), /error=/);
  const signedIn = await handler(new Request("http://localhost/login", {
    method: "POST",
    body: new URLSearchParams({
      password: "ssr-password",
      next: "/"
    })
  }));
  assert.equal(signedIn.status, 303);
  const cookie = signedIn.headers.getSetCookie()[0].split(";", 1)[0];
  assert.match(cookie, /^bindery_session=/);
  const db = new DatabaseSync(process.env.BINDERY_DB_PATH);
  db.exec("INSERT INTO books(book_id,title) VALUES ('a','A'), ('b','B'), ('c','C')");
  const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(cookie.split("=")[1]);
  assert.equal(row.auth_method, "password");
  assert.ok(row.password_verified_at);
  db.close();
  const response = await get("/", cookie);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /data-testid="book-count">3<\/strong>/);
  assert.match(html, /安全设置/);
  const security = await get("/security", cookie);
  assert.equal(security.status, 200);
  const securityHtml = await security.text();
  assert.match(securityHtml, /通行密钥/);
  assert.match(securityHtml, /退出登录/);
  assert.doesNotMatch(securityHtml, /public_key|transports_json|password_verified_at|ssr-password/);
  const assets = [...(html + loginHtml + securityHtml).matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(m => m[1]);
  assert.ok(assets.some(p => p.endsWith(".css")));
  assert.ok(assets.some(p => p.endsWith(".js")));
  for (const asset of new Set(assets)) {
    const result = await get(asset);
    assert.equal(result.status, 200, asset);
    assert.ok((await result.arrayBuffer()).byteLength > 0);
  }
  const server = await readFile(new URL("../dist/server/server.js", import.meta.url), "utf8");
  const id = /"([a-f0-9]{64})":\s*\{\s*functionName: "getBookCount_createServerFn_handler"/.exec(server)?.[1];
  assert.ok(id, "built server function manifest");
  const rpcPath = `/_serverFn/data/${id}?args=${encodeURIComponent(JSON.stringify([{
    method: "GET",
    context: {}
  }]))}`;
  assert.equal((await get(rpcPath)).status, 303);
  const rpc = await handler(new Request("http://localhost" + rpcPath, {
    headers: {
      Cookie: cookie,
      Origin: "http://localhost",
      "Sec-Fetch-Site": "same-origin"
    }
  }));
  assert.equal(rpc.status, 200);
  assert.deepEqual((await rpc.json()).result, {
    count: 3,
    missing: false
  });
  const hidden = await get("/.vite/manifest.json", cookie);
  assert.equal(hidden.status, 404);
  await hidden.text();
  const logout = await handler(new Request("http://localhost/logout", {
    method: "POST",
    headers: {
      Cookie: cookie
    }
  }));
  assert.equal(logout.status, 303);
  assert.equal((await get("/security", cookie)).status, 303);
  console.log("Production login/security SSR, SQLite sessions, protected RPC, logout and public assets: PASS (no sockets)");
} finally {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];else process.env[name] = value;
  }
  await rm(dir, {
    recursive: true,
    force: true
  });
}
