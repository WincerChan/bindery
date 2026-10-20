import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { hash } from "@node-rs/argon2";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { clientDocument } from "../../support/client-dom.ts";

// Exercise the complete, unmodified production entry, real compiled callers,
// server-function middleware/codec and Router. Only the network boundary is
// in-process; no private Start handler or alternate auth path is exposed.
const root = await mkdtemp(join(tmpdir(), "bindery-redirect-probe-"));
let app, mounted, db;
try {
  for (const key of ["BINDERY_LIBRARY_DIR", "BINDERY_DB_PATH", "BINDERY_PASSWORD_HASH", "BINDERY_TEMPLATE_DIR", "BINDERY_RULES_DIR", "BINDERY_THEMES_DIR", "BINDERY_PUBLIC_ORIGIN", "BINDERY_WEBAUTHN_RP_ID"]) { delete process.env[key]; delete process.env[key + "_FILE"]; }
  Object.assign(process.env, { BINDERY_LIBRARY_DIR: join(root, "library"), BINDERY_DB_PATH: join(root, "data.db"), BINDERY_TEMPLATE_DIR: join(root, "templates"), BINDERY_PASSWORD_HASH: await hash("probe-password", { memoryCost: 8192, timeCost: 1 }) });
  app = (await import("../../../dist/server/server.js")).default;
  const directory = new URL("../../../dist/server/", import.meta.url);
  const manifest = (await Promise.all((await readdir(directory)).filter(n => n.includes("server-fn-resolver")).map(n => readFile(new URL(n, directory), "utf8")))).join("\n");
  function id(name) { const value = new RegExp('"([a-f0-9]{64})":\\s*\\{\\s*functionName: "' + name + '_createServerFn_handler"').exec(manifest)?.[1]; assert.ok(value, name); return value; }
  const assets = new URL("../../../dist/client/assets/", import.meta.url);
  const document = clientDocument(), body = document.createElement("body");
  body.dispatchEvent = () => true; Object.defineProperty(document, "body", { value: body });
  document.addEventListener = () => {}; document.removeEventListener = () => {};
  Object.assign(globalThis, { document, window: globalThis, self: globalThis, addEventListener() {}, removeEventListener() {}, scrollTo() {} });
  globalThis.location = Object.assign(new URL("http://localhost/current?q=one&page=3"), { assign() { assert.fail("Unexpected full-page navigation"); } });
  // Import the actual emitted tracker route loader and saveTracker export,
  // including their compiled middleware chains, rather than rebuilding wrappers.
  let route, mutation, loginRoute;
  for (const name of (await readdir(assets)).filter(n => n.endsWith(".js"))) {
    if (!name.startsWith("_app.tracker-") && !name.startsWith("mutations-") && !name.startsWith("login-")) continue;
    const source = await readFile(new URL(name, assets), "utf8");
    if (name.startsWith("_app.tracker-") && source.includes("loader:")) {
      route = Object.values(await import(new URL(name, assets))).find(value => value?.options?.loader);
    }
    if (name.startsWith("mutations-") && source.includes(id("saveTracker"))) {
      mutation = Object.values(await import(new URL(name, assets))).find(value => value?.serverFnMeta?.id === id("saveTracker"));
    }
    if (name.startsWith("login-") && source.includes("loader:")) {
      loginRoute = Object.values(await import(new URL(name, assets))).find(value => value?.options?.loader);
    }
  }
  assert.ok(route?.options.loader); assert.ok(mutation); assert.ok(loginRoute?.options.loader);
  const loader = () => route.options.loader({ deps: {} });
  const ui = await import(pathToFileURL(process.argv[2]).href);
  let referer = "", wire = [], caught = [], sessionCookie = "";
  const target = request => app.fetch(request);
  // Replace only the network boundary with in-process Requests. Browser fetch
  // follows 303s; reproduce that here rather than passing a raw 303 to the codec.
  globalThis.fetch = async (input, init) => {
    let url = new URL(input instanceof Request ? input.url : input, "http://localhost");
    const headers = new Headers(init?.headers); if (referer) headers.set("Referer", referer);
    if (sessionCookie) headers.set("Cookie", sessionCookie);
    if (init?.method === "POST") headers.set("Origin", "http://localhost");
    let request = new Request(url, { ...init, headers });
    let response = await target(request), followed = false;
    wire.push({ method: request.method, status: response.status, location: response.headers.get("Location"), format: response.headers.get("X-Server-Function-Format"), cacheControl: response.headers.get("Cache-Control") });
    while (response.status >= 300 && response.status < 400 && response.headers.has("Location")) {
      url = new URL(response.headers.get("Location"), url); followed = true;
      request = new Request(url, { headers }); response = await target(request);
      wire.push({ method: request.method, status: response.status, location: response.headers.get("Location"), format: response.headers.get("X-Server-Function-Format"), cacheControl: response.headers.get("Cache-Control") });
    }
    if (followed) {
      // The codec rejects HTML before reading its body. Drain the real SSR
      // stream so its request lifecycle closes, then preserve the bytes/headers.
      response = new Response(await response.text(), { status: response.status, headers: response.headers });
      Object.defineProperties(response, { redirected: { value: true }, url: { value: url.href } });
    }
    return response;
  };
  const load = async () => {
    try { return await loader(); }
    catch (error) { caught.push({ path: "loader", redirect: ui.isRedirect(error), href: error.options?.href }); throw error; }
  };
  const write = async () => {
    try { return await mutation({ data: { fields: { title: "blocked" } } }); }
    catch (error) { caught.push({ path: "mutation", redirect: ui.isRedirect(error), href: error.options?.href }); throw error; }
  };
  const successes = [];
  for (const [label, ref, expected] of [["same-origin", "http://localhost/current?q=one&page=3", "/login?next=%2Fcurrent%3Fq%3Done%26page%3D3"], ["cross-origin", "https://evil.test/current", "/login?next=%2F"], ["missing", "", "/login?next=%2F"]]) {
    referer = ref;
    for (const path of ["loader", "mutation"]) {
      const node = document.createElement("div"); document.documentElement.appendChild(node);
      mounted = await ui.redirectClient(node, load, write); globalThis.__TSR_ROUTER__ = mounted.router;
      wire = []; caught = [];
      if (path === "loader") await mounted.navigate(); else await mounted.run();
      await new Promise(resolve => setTimeout(resolve, 0)); mounted.flush();
      assert.equal(mounted.href(), expected); assert.match(node.textContent, /登录页面/);
      assert.deepEqual(caught, [{ path, redirect: true, href: expected }]);
      assert.equal(wire.length, 1); assert.equal(wire[0].method, path === "loader" ? "GET" : "POST");
      assert.equal(wire[0].status, 200); assert.ok(wire[0].format);
      assert.equal(wire[0].location, null); assert.equal(wire[0].cacheControl, "no-store");
      successes.push({ referer: label, path, caught: caught[0], wire: wire[0] });
      mounted.dispose(); mounted = undefined; node.remove();
    }
  }
  // Ordinary pages, APIs and resource paths still stop at the entrance gate,
  // with the original 303/401 behavior (including POST and HX requests).
  const entrance = [];
  for (const path of ["/tracker?q=private", "/tracker/duplicate-check?title=private", "/assets/private.js"]) {
    for (const method of ["GET", "POST"]) for (const hx of [false, true]) {
      const response = await app.fetch(new Request("http://localhost" + path, { method, headers: hx ? { "HX-Request": "true" } : {} }));
      assert.equal(response.status, hx ? 401 : 303);
      assert.equal(response.headers.get(hx ? "HX-Redirect" : "Location"), "/login?next=" + path.split("?", 1)[0]);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      entrance.push({ path, method, hx, status: response.status });
      await response.text();
    }
  }
  // Authentication must run before the local validator or handler, even on a
  // mutation with NO .middleware([authenticated]) at its definition.
  referer = "http://localhost/current?q=one&page=3";
  await assert.rejects(mutation({ data: { fields: { title: 123 } } }), error => ui.isRedirect(error));
  db = new DatabaseSync(process.env.BINDERY_DB_PATH, { timeout: 5000 });
  assert.equal(db.prepare("SELECT count(*) AS n FROM wishlist").get().n, 0);

  // Login has no createServerFn RPC exemption: exercise the actual compiled
  // login loader's public /login/data HTTP path, plus SSR/password/passkey paths.
  globalThis.location.href = "http://localhost/login?next=%2Ftracker%3Fq%3Done";
  const loginData = await loginRoute.options.loader();
  assert.equal(loginData.hash_configured, true); assert.equal(loginData.next, "/tracker?q=one");
  const loginPage = await app.fetch(new Request("http://localhost/login"));
  assert.equal(loginPage.status, 200); assert.match(await loginPage.text(), /action="\/login"/);
  const passkey = await app.fetch(new Request("http://localhost/login/passkey/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
  assert.equal(passkey.status, 404); assert.equal((await passkey.json()).error, "通行密钥不可用");
  const login = await app.fetch(new Request("http://localhost/login", { method: "POST", body: new URLSearchParams({ password: "probe-password", next: "/tracker?q=one" }) }));
  assert.equal(login.status, 303); assert.equal(login.headers.get("Location"), "/tracker?q=one");
  sessionCookie = login.headers.getSetCookie()[0].split(";", 1)[0]; assert.ok(sessionCookie);
  globalThis.location.href = "http://localhost/current?q=one&page=3";
  const saved = await mutation({ data: { fields: { title: "global authenticated mutation" } } });
  assert.equal(saved.target, "/tracker");
  assert.equal(db.prepare("SELECT count(*) AS n FROM wishlist WHERE title = ?").get("global authenticated mutation").n, 1);
  const loaded = await loader(); assert.equal(loaded.wishes[0].title, "global authenticated mutation");
  const authenticatedApi = await app.fetch(new Request("http://localhost/tracker/duplicate-check?title=global", { headers: { Cookie: sessionCookie } }));
  assert.equal(authenticatedApi.status, 200); await authenticatedApi.json();
  // Session expiry also returns a serialized redirect rather than login HTML.
  db.prepare("DELETE FROM sessions").run();
  await assert.rejects(loader(), error => ui.isRedirect(error));
  await assert.rejects(mutation({ data: { fields: { title: "expired" } } }), error => ui.isRedirect(error));
  assert.equal(db.prepare("SELECT count(*) AS n FROM wishlist").get().n, 1);
  console.log(JSON.stringify({ productionRedirects: successes, entrance, authenticationBeforeValidation: true, anonymousLogin: { transport: "HTTP (no anonymous server-function exemptions)", loader: true, ssr: 200, passkey: 404, password: 303 }, authenticated: { loader: true, mutation: true, api: 200, libraryContext: true }, expiredSession: { loader: true, mutation: true, noWrite: true } }));
} finally { mounted?.dispose(); db?.close(); try { await app?.shutdownRuntime(); } finally { await rm(root, { recursive: true, force: true }); } }
