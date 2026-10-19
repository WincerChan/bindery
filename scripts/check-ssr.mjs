import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hash } from "@node-rs/argon2";
import { zipSync, strToU8 } from "fflate";
import { createProductionHandler } from "./production-handler.mjs";
const dir = await mkdtemp(join(tmpdir(), "bindery-ssr-"));
const names = ["BINDERY_DB_PATH", "BINDERY_LIBRARY_DIR", "BINDERY_PASSWORD_HASH", "BINDERY_PUBLIC_ORIGIN", "BINDERY_WEBAUTHN_RP_ID"];
const previous = Object.fromEntries(names.flatMap(name => [name, `${name}_FILE`]).map(name => [name, process.env[name]]));
let handler, db;
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
  handler = await createProductionHandler();
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
  db = new DatabaseSync(process.env.BINDERY_DB_PATH);
  const bookId = "a".repeat(32);
  db.prepare("INSERT INTO books(book_id,title,author,source_type,theme_template,cover_file) VALUES (?, '乱世书', '姬叉', 'epub', '__book__', 'cover.png')").run(bookId);
  db.exec("INSERT INTO books(book_id,title) VALUES ('b','B'), ('c','C')");
  const bookDir = join(process.env.BINDERY_LIBRARY_DIR, bookId);
  await mkdir(bookDir, { recursive: true });
  await writeFile(join(bookDir, "book.json"), "{}");
  const coverBytes = Buffer.from("89504e470d0a1a0a", "hex");
  await writeFile(join(bookDir, "cover.png"), coverBytes);
  const epubBytes = zipSync({ mimetype: strToU8("application/epub+zip") });
  await writeFile(join(bookDir, "book.epub"), epubBytes);
  const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(cookie.split("=")[1]);
  assert.equal(row.auth_method, "password");
  assert.ok(row.password_verified_at);
  db.close();
  const response = await get("/", cookie);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /id="app-content"/);
  assert.match(html, /aria-label="主导航"/);
  assert.match(html, /aria-label="手机导航"/);
  const nav = html.match(/aria-label="主导航"[^>]*>([\s\S]*?)<\/nav>/)[1];
  assert.deepEqual([...nav.matchAll(/href="([^"]+)"/g)].map(m => m[1]), ["/", "/ingest", "/jobs", "/tracker", "/rules", "/archive", "/kindle", "/security"]);
  assert.match(nav, /href="\/"[^>]*aria-current="page"/);
  assert.doesNotMatch(loginHtml, /aria-label="主导航"/);
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
  const serverDir = new URL("../dist/server/", import.meta.url);
  const server = (await Promise.all((await readdir(serverDir)).filter(name => name === "server.js" || name.includes("server-fn-resolver")).map(name => readFile(new URL(name, serverDir), "utf8")))).join("\n");
  const id = /"([a-f0-9]{64})":\s*\{\s*functionName: "checkSession_createServerFn_handler"/.exec(server)?.[1];
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
  assert.equal((await rpc.json()).result, true);
  const coverPath = `/book/${bookId}/cover?v=1`;
  assert.equal((await get(coverPath)).status, 303);
  const cover = await get(coverPath, cookie);
  assert.equal(cover.status, 200);
  assert.equal(cover.headers.get("cache-control"), "private, max-age=604800, immutable");
  assert.equal(cover.headers.get("cdn-cache-control"), "no-store");
  assert.equal(cover.headers.get("cloudflare-cdn-cache-control"), "no-store");
  assert.deepEqual(Buffer.from(await cover.arrayBuffer()), coverBytes);
  const cached = await handler(new Request("http://localhost" + coverPath, { headers: { Cookie: cookie, "If-None-Match": cover.headers.get("etag") } }));
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), "");
  const download = await get(`/book/${bookId}/download`, cookie);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "application/epub+zip");
  assert.equal(download.headers.get("cache-control"), "no-store");
  assert.equal(decodeURIComponent(download.headers.get("content-disposition").split("''")[1]), "乱世书-姬叉.epub");
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from(epubBytes));
  const missing = await get(`/book/${"f".repeat(32)}/cover`, cookie);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { detail: "书籍不存在" });
  const kindle = await get("/kindle", cookie);
  assert.equal(kindle.status, 200);
  assert.match(await kindle.text(), /排版与预览/);
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
  const stopped = handler.shutdown();
  assert.equal(handler.shutdown(), stopped);
  await stopped;
  assert.equal((await get("/login")).status, 503);
  assert.equal((await get(assets[0])).status, 503);
  console.log("Production auth/layout SSR, protected RPC, cover/download routes, Kindle placeholder and public assets: PASS (no sockets)");
} finally {
  if (db?.isOpen) db.close();
  try { await handler?.shutdown(); }
  finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}
