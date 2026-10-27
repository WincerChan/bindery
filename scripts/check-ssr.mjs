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
  db = new DatabaseSync(process.env.BINDERY_DB_PATH, { timeout: 5000 });
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
  assert.deepEqual([...nav.matchAll(/<a\b[^>]*class="nav-link[^>]*>/g)].map(m => /href="([^"]+)"/.exec(m[0])[1]), ["/", "/ingest", "/tracker", "/vocabulary", "/devices"]);
  assert.match(html, /href="\/settings"[^>]*class="nav-link rail-settings/);
  assert.doesNotMatch(html, /settings-dropdown|more-sheet|role="menu"/);
  const mobile = html.match(/aria-label="手机导航"[^>]*>([\s\S]*?)<\/nav>/)[1];
  assert.deepEqual([...mobile.matchAll(/href="([^"]+)"/g)].map(m => m[1]), ["/", "/ingest", "/tracker", "/vocabulary", "/settings"]);
  assert.doesNotMatch(nav + mobile, /href="\/(jobs|archive)"/);
  assert.match(nav, /href="\/"[^>]*aria-current="page"/);
  assert.doesNotMatch(loginHtml, /aria-label="主导航"/);
  const security = await get("/security", cookie);
  assert.equal(security.status, 200);
  const securityHtml = await security.text();
  assert.match(securityHtml, /通行密钥/);
  assert.match(securityHtml, /href="\/settings"[^>]*aria-current="page"/);
  const settingsPage = await get("/settings", cookie);
  assert.equal(settingsPage.status, 200);
  const settingsHtml = (await settingsPage.text()).replace(/<!--[\s\S]*?-->/g, "");
  for (const title of ["切章规则", "主题", "安全", "LexiTrace", "安装应用", "退出登录"]) assert.ok(settingsHtml.includes(title), title);
  assert.match(settingsHtml, /条 · 最近改过「/);
  assert.match(settingsHtml, /个 · 入库默认用「/);
  assert.match(settingsHtml, /0 个通行密钥 · 尚未使用/);
  assert.match(settingsHtml, /未配置 · 连接后可自动推送生词/);
  assert.match(settingsHtml, /action="\/logout" method="post"/);
  assert.match(settingsHtml, /href="\/rules\?tab=themes"/);
  assert.match(settingsHtml, /href="\/vocabulary\?settings=lexitrace#lexitrace-settings"/);
  const vocabularyPage = await get("/vocabulary?settings=lexitrace", cookie);
  assert.equal(vocabularyPage.status, 200);
  const vocabularyHtml = await vocabularyPage.text();
  assert.match(vocabularyHtml, /<title\b[^>]*>生词本 · Bindery<\/title>/);
  assert.match(vocabularyHtml, /<details[^>]*id="lexitrace-settings"[^>]*\sopen(?:[\s=>])/);
  assert.doesNotMatch(vocabularyHtml, /class="kindle-mobile-note"|aria-label="设备管理"/);
  assert.equal((await get("/settings")).status, 303);
  assert.equal((await get("/vocabulary")).status, 303);
  for (const suffix of ["", "?settings=lexitrace&keep=a%26b"]) {
    const legacy = await get("/devices/vocabulary" + suffix, cookie);
    assert.equal(legacy.status, 308);
    assert.equal(legacy.headers.get("location"), "/vocabulary" + suffix);
  }
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
  const anonymousRpc = await get(rpcPath);
  assert.equal(anonymousRpc.status, 200);
  assert.equal(anonymousRpc.headers.get("cache-control"), "no-store");
  assert.ok(anonymousRpc.headers.get("X-Server-Function-Format"));
  assert.equal(anonymousRpc.headers.get("Location"), null);
  const deniedRpc = await anonymousRpc.json();
  assert.equal(deniedRpc.error.isSerializedRedirect, true);
  assert.equal(deniedRpc.error.href, "/login?next=%2F");
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
  const devicesPage = await get("/devices", cookie);
  assert.equal(devicesPage.status, 200);
  const devicesHtml = await devicesPage.text();
  assert.match(devicesHtml, /排版与预览/);
  const phoneDevices = devicesHtml.match(/class="kindle-mobile-note"[\s\S]*?<div\b[^>]*class="kindle-page/)[0];
  for (const text of ["阅读器要在电脑上连接。", "Chrome 或 Edge", "把书库里的书发到阅读器", "给阅读器装字体", "同步阅读进度和生词", "回书库"]) assert.ok(phoneDevices.includes(text), text);
  assert.match(phoneDevices, /href="\/vocabulary"/);
  assert.doesNotMatch(devicesHtml, /href="\/devices\/vocabulary"/);
  for (const [legacy, target] of [["/kindle", "/devices"], ["/kindle/preview?book=a", "/devices/preview?book=a"], ["/kindle/transfer", "/devices/transfer"]]) {
    const response = await get(legacy, cookie);
    assert.ok([302, 303, 307, 308].includes(response.status), `${legacy} status ${response.status}`);
    assert.equal(response.headers.get("location"), target, legacy);
    await response.text();
  }
  const legacyAsset = await get("/kindle/content/a/11/epub/x.xhtml", cookie);
  assert.equal(legacyAsset.status, 302);
  assert.equal(legacyAsset.headers.get("location"), "/devices/content/a/11/epub/x.xhtml");
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
  console.log("Production auth/layout SSR, protected RPC, cover/download routes, device pages/redirects and public assets: PASS (no sockets)");
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
