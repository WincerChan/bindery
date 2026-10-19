import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { signIn } from "../src/server/auth";
import { readerFixture } from "./fixtures/reader/support";

it.runIf(existsSync("dist/server/server.js"))("serves both Kindle pages and authenticates all six compiled preview/profile RPCs without sockets", async () => {
  const fixture = readerFixture();
  try {
    const script = join(fixture.root, "check-typeset.mjs");
    writeFileSync(script, `
      import assert from "node:assert/strict";
      import { readdirSync, readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { createProductionHandler } from ${JSON.stringify(pathToFileURL(resolve("scripts/production-handler.mjs")).href)};
      const [root, bookId, session, serverDir] = process.argv.slice(2);
      for (const key of ["BINDERY_LIBRARY_DIR", "BINDERY_DB_PATH", "BINDERY_PASSWORD_HASH", "BINDERY_PUBLIC_ORIGIN", "BINDERY_RULES_DIR", "BINDERY_THEMES_DIR", "BINDERY_TEMPLATE_DIR"]) { process.env[key] = ""; process.env[key + "_FILE"] = ""; }
      process.env.BINDERY_LIBRARY_DIR = join(root, "library"); process.env.BINDERY_DB_PATH = join(root, "db.sqlite");
      const handler = await createProductionHandler();
      const get = (path, auth = true) => handler(new Request("http://localhost" + path, { headers: { Cookie: auth ? "bindery_session=" + session : "" } }));
      for (const page of ["/kindle/preview?book=" + bookId, "/kindle/fonts"]) {
        assert.equal((await get(page, false)).status, 303);
        const response = await get(page); assert.equal(response.status, 200); const html = await response.text();
        assert.match(html, /检测中/); assert.doesNotMatch(html, /allow-scripts|srcdoc=/); assert.ok(!html.includes(root));
        assert.match(html, page.includes("preview") ? /Kindle 章节排版预览/ : /字体管理/);
      }
      const manifest = readdirSync(serverDir).filter(name => name.includes("server-fn-resolver")).map(name => readFileSync(join(serverDir, name), "utf8")).join("\\n");
      function rpc(name, method, data, auth = true) {
        const id = new RegExp('"([a-f0-9]{64})":\\\\s*\\\\{\\\\s*functionName: "' + name + '_createServerFn_handler"').exec(manifest)?.[1];
        assert.ok(id, name + " RPC manifest");
        const args = JSON.stringify([{ data, context: {} }]);
        const url = "http://localhost/_serverFn/data/" + id + (method === "GET" ? "?args=" + encodeURIComponent(args) : "");
        return handler(new Request(url, { method, ...(method === "POST" ? { body: args } : {}), headers: { Cookie: auth ? "bindery_session=" + session : "", Origin: "http://localhost", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", "X-Server-Function-Format": "8" } }));
      }
      const settings = { marginX: 1, marginY: null, lineHeight: 1.6, paragraphSpacing: null, textIndent: 2, justify: true, fontFamily: null, customCss: "" };
      const input = { deviceId: "test-device", name: "正文", settings };
      for (const [name, method, data] of [["getPreview", "GET", bookId], ["getChapters", "GET", bookId], ["listKindleProfiles", "GET", "test-device"], ["createKindleProfile", "POST", input], ["updateKindleProfile", "POST", { ...input, id: "missing" }], ["deleteKindleProfile", "POST", { deviceId: "test-device", id: "missing" }]]) {
        const response = await rpc(name, method, data, false); assert.equal(response.status, 303, name); await response.text();
      }
      const result = async response => { assert.equal(response.status, 200); const payload = await response.json(); assert.ok(!payload.error, JSON.stringify(payload)); return payload.result; };
      const preview = await result(await rpc("getPreview", "GET", bookId)); assert.equal(preview.bookId, bookId); assert.ok(preview.sections.length > 0);
      assert.deepEqual(await result(await rpc("getChapters", "GET", bookId)), preview.sections);
      const initial = await result(await rpc("listKindleProfiles", "GET", "test-device")); assert.equal(initial.length, 1); assert.equal(initial[0].builtIn, true);
      const created = await result(await rpc("createKindleProfile", "POST", input)); assert.equal(created.deviceId, "test-device");
      const updated = await result(await rpc("updateKindleProfile", "POST", { ...input, id: created.id, name: "已更新" })); assert.equal(updated.name, "已更新");
      assert.equal((await result(await rpc("listKindleProfiles", "GET", "another-device"))).length, 1);
      await result(await rpc("deleteKindleProfile", "POST", { deviceId: "test-device", id: created.id }));
      assert.equal((await result(await rpc("listKindleProfiles", "GET", "test-device"))).length, 1);
      writeFileSync(join(root, "typeset-result.json"), JSON.stringify({ ok: true }));
    `);
    await promisify(execFile)(process.execPath, [script, fixture.root, fixture.id, signIn(fixture.library.db), resolve("dist/server")], { timeout: 20000 });
    expect(JSON.parse(readFileSync(join(fixture.root, "typeset-result.json"), "utf8"))).toEqual({ ok: true });
  } finally { fixture.cleanup(); }
});
