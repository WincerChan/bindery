import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { signIn } from "../src/server/auth";
import { epubPath } from "../src/server/storage";
import { obfuscatedEpub } from "./fixtures/reader/obfuscated";
import { readerFixture } from "./fixtures/reader/support";

it.runIf(existsSync("dist/server/server.js"))("serves both Kindle pages and authenticates all six compiled preview/profile RPCs without sockets", async () => {
  const fixture = readerFixture();
  try {
    const book = obfuscatedEpub();
    writeFileSync(epubPath(fixture.library.base, fixture.id), book.data);
    writeFileSync(join(fixture.root, "typeset-paths.json"), JSON.stringify({ paths: book.paths, css: book.css, importedCss: book.importedCss, image: book.image, font: book.font }));
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
      try {
      const get = (path, auth = true, method = "GET") => handler(new Request("http://localhost" + path, { method, headers: { Cookie: auth ? "bindery_session=" + session : "" } }));
      const book = JSON.parse(readFileSync(join(root, "typeset-paths.json"), "utf8"));
      const encodePath = path => path.split("/").map(part => encodeURIComponent(part).replace(/[!'()*~]/g, ch => "%" + ch.charCodeAt(0).toString(16).toUpperCase())).join("/");
      for (const page of ["/kindle/preview?book=" + bookId, "/kindle/fonts"]) {
        assert.equal((await get(page, false)).status, 303);
        const response = await get(page); assert.equal(response.status, 200); const html = await response.text();
        assert.match(html, /检测中/); assert.doesNotMatch(html, /allow-scripts|srcdoc=/); assert.ok(!html.includes(root));
        assert.match(html, page.includes("preview") ? /Kindle 章节排版预览/ : /字体管理/);
        if (page.includes("preview")) {
          assert.ok(html.includes("/book/" + bookId + "/epub/" + encodePath(book.paths[0])), "iframe member path must round-trip");
          assert.match(html, /aria-label="预览翻页"/); assert.match(html, /aria-live="polite"/);
          assert.match(html, /上一页/); assert.match(html, /下一页/); assert.match(html, /正在分页/);
          assert.match(html, /上下页边距按 KPW3 窄边距实测，其他档位与型号为估算/);
          assert.match(html, /class="kt-preview kt-preview-sticky"/);
          assert.ok(html.includes('<details class="kt-calibration"><summary>校准说明</summary>'));
          // The built-in profile renders no adjustable controls, only the new-profile action.
          assert.doesNotMatch(html, /id="kt-marginX"|class="kt-checkboxes"|class="kt-advanced"/);
          assert.match(html, /默认方案只使用书籍自带样式，不做任何调整/); assert.match(html, />新建方案</);
          assert.doesNotMatch(html, /收窄到约 1 字边距|负值收窄 Kindle 自身页边距|设备默认字体（保留书籍字体样式）/);
        }
      }
      const manifest = readdirSync(serverDir).filter(name => name.includes("server-fn-resolver")).map(name => readFileSync(join(serverDir, name), "utf8")).join("\\n");
      function rpc(name, method, data, auth = true) {
        const id = new RegExp('"([a-f0-9]{64})":\\\\s*\\\\{\\\\s*functionName: "' + name + '_createServerFn_handler"').exec(manifest)?.[1];
        assert.ok(id, name + " RPC manifest");
        const args = JSON.stringify([{ data, context: {} }]);
        const url = "http://localhost/_serverFn/data/" + id + (method === "GET" ? "?args=" + encodeURIComponent(args) : "");
        return handler(new Request(url, { method, ...(method === "POST" ? { body: args } : {}), headers: { Cookie: auth ? "bindery_session=" + session : "", Origin: "http://localhost", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", "X-Server-Function-Format": "8" } }));
      }
      const settings = { marginX: 1, marginY: null, lineHeight: 1.6, paragraphSpacing: null, textIndent: 2, justify: true, fontFamily: null, customCss: "", stripFonts: true, stripImages: true };
      const input = { deviceId: "test-device", name: "正文", settings };
      for (const [name, method, data] of [["getPreview", "GET", bookId], ["getChapters", "GET", bookId], ["listKindleProfiles", "GET", "test-device"], ["createKindleProfile", "POST", input], ["updateKindleProfile", "POST", { ...input, id: "missing" }], ["deleteKindleProfile", "POST", { deviceId: "test-device", id: "missing" }]]) {
        const response = await rpc(name, method, data, false); assert.equal(response.status, 200, name);
        assert.ok(response.headers.get("X-Server-Function-Format")); assert.equal(response.headers.get("Location"), null);
        const payload = await response.json(); assert.equal(payload.error.isSerializedRedirect, true); assert.equal(payload.error.href, "/login?next=%2F");
      }
      const result = async response => { assert.equal(response.status, 200); const payload = await response.json(); assert.ok(!payload.error, JSON.stringify(payload)); return payload.result; };
      const preview = await result(await rpc("getPreview", "GET", bookId)); assert.equal(preview.bookId, bookId); assert.ok(preview.sections.length > 0);
      assert.deepEqual(preview.sections.map(section => section.item_path), book.paths);
      const assetPath = "/kindle/content/" + bookId + "/11/epub/" + encodePath(preview.sections[0].item_path);
      assert.equal((await get(assetPath, false)).status, 303);
      const asset = await get(assetPath); assert.equal(asset.status, 200); assert.ok((await asset.text()).includes('<base href="http://localhost/kindle/content/'));
      for (const mode of ["00", "01", "10", "11"]) {
        const prefix = "/kindle/content/" + bookId + "/" + mode + "/epub/";
        for (const member of [...book.paths, book.css, book.importedCss, book.image, book.font, ...["%2e%2e", "%2F", "#", "?", "a:b", "::|"].map(name => "OEBPS/Images/" + name)]) {
          const response = await get(prefix + encodePath(member));
          const removed = (mode[0] === "1" && member === book.font) || (mode[1] === "1" && member === book.image);
          assert.equal(response.status, removed ? 404 : 200, mode + " " + member);
          const content = await response.text();
          if (removed) continue;
          assert.match(response.headers.get("content-security-policy"), /sandbox allow-same-origin; default-src 'none'; script-src 'none'/);
          if (member === book.paths[0]) {
            assert.ok(content.includes(prefix + encodePath(book.css))); assert.ok(content.includes(prefix + encodePath(book.paths[1]) + "#note"));
            assert.doesNotMatch(content, /<script|<form|parent.attack/);
            if (mode[1] === "1") assert.doesNotMatch(content, /<img/);
            else assert.ok(content.includes(prefix + encodePath(book.image)));
          }
        }
        const head = await get(prefix + encodePath(book.paths[0]), true, "HEAD"); assert.equal(head.status, 200); assert.equal(await head.text(), "");
        for (const path of ["%00x", "a%5Cb", "a%0Ab", "a%2F..%2Fx", "absent.xhtml"]) assert.equal((await get(prefix + path)).status, 404);
      }
      assert.deepEqual(await result(await rpc("getChapters", "GET", bookId)), preview.sections);
      const initial = await result(await rpc("listKindleProfiles", "GET", "test-device")); assert.equal(initial.length, 1); assert.equal(initial[0].builtIn, true);
      const created = await result(await rpc("createKindleProfile", "POST", input)); assert.equal(created.deviceId, "test-device");
      assert.equal(created.settings.stripFonts, true); assert.equal(created.settings.stripImages, true);
      const updated = await result(await rpc("updateKindleProfile", "POST", { ...input, id: created.id, name: "已更新" })); assert.equal(updated.name, "已更新");
      const stored = (await result(await rpc("listKindleProfiles", "GET", "test-device")))[1]; assert.deepEqual(stored.settings, { ...settings, deviceModel: "KPW3", kindleMargin: "narrow", marginXUnit: "em" });
      const negative = { ...settings, deviceModel: "KO3", kindleMargin: "medium", marginX: -4.8, marginXUnit: "percent" };
      await result(await rpc("updateKindleProfile", "POST", { ...input, id: created.id, settings: negative }));
      assert.deepEqual((await result(await rpc("listKindleProfiles", "GET", "test-device")))[1].settings, negative);
      assert.equal((await result(await rpc("listKindleProfiles", "GET", "another-device"))).length, 1);
      await result(await rpc("deleteKindleProfile", "POST", { deviceId: "test-device", id: created.id }));
      assert.equal((await result(await rpc("listKindleProfiles", "GET", "test-device"))).length, 1);
      writeFileSync(join(root, "typeset-result.json"), JSON.stringify({ ok: true }));
      } finally { await handler.shutdown(); }
    `);
    await promisify(execFile)(process.execPath, [script, fixture.root, fixture.id, signIn(fixture.library.db), resolve("dist/server")], { timeout: 20000 });
    expect(JSON.parse(readFileSync(join(fixture.root, "typeset-result.json"), "utf8"))).toEqual({ ok: true });
  } finally { fixture.cleanup(); }
});
