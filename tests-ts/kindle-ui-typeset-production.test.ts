import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { allByRole, byLabel, byRole, parseHtml } from "./support/queries";
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
    for (const [device_id, section] of [["mapped-device", 1], ["unmapped-device", null], ["stale-device", 999]] as const) fixture.library.db.upsertDeviceReading({ book_id: fixture.id, device_id, device_kind: "kobo", device_name: device_id, section, section_fraction: 0.2, percent: 99, location: null, read_status: "reading", last_read_at: null, time_spent_seconds: 0, rest_estimate_seconds: null, synced_at: new Date().toISOString() });
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
      const pages = {};
      for (const page of ["/devices/preview?book=" + bookId, "/devices/fonts"]) {
        assert.equal((await get(page, false)).status, 303);
        const response = await get(page); assert.equal(response.status, 200); const html = await response.text();
        assert.match(html, page.includes("preview") ? /正在分页/ : /检测中/); assert.doesNotMatch(html, /allow-scripts|srcdoc=/); assert.ok(!html.includes(root));
        pages[page.includes("preview") ? "preview" : "fonts"] = html;
        assert.match(html, page.includes("preview") ? /Kindle 章节排版预览/ : /连接设备/);
        if (page.includes("preview")) {
          assert.ok(html.includes("/book/" + bookId + "/epub/" + encodePath(book.paths[0])), "iframe member path must round-trip");
          assert.match(html, /实测：Kindle Paperwhite 3 窄边距、Kobo Libra 2 最小边距/);
          // The built-in profile is editable and can be sent without being saved as a profile.
          assert.match(html, /调整后可直接发送，不必保存为方案/);
          assert.doesNotMatch(html, /默认方案只使用书籍自带样式|要调整边距、行高等，请新建方案/);
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
      const settings = { marginX: 1, marginY: null, lineHeight: 1.6, paragraphSpacing: null, textIndent: 2, fontFamily: null, customCss: "", stripFonts: true, stripImages: true };
      const input = { name: "正文", settings };
      for (const [name, method, data] of [["getPreview", "GET", bookId], ["getChapters", "GET", bookId], ["listTypesetProfiles", "GET", undefined], ["createTypesetProfile", "POST", input], ["updateTypesetProfile", "POST", { ...input, id: "missing" }], ["deleteTypesetProfile", "POST", { id: "missing" }]]) {
        const response = await rpc(name, method, data, false); assert.equal(response.status, 200, name);
        assert.ok(response.headers.get("X-Server-Function-Format")); assert.equal(response.headers.get("Location"), null);
        const payload = await response.json(); assert.equal(payload.error.isSerializedRedirect, true); assert.equal(payload.error.href, "/login?next=%2F");
      }
      const result = async response => { assert.equal(response.status, 200); const payload = await response.json(); assert.ok(!payload.error, JSON.stringify(payload)); return payload.result; };
      const preview = await result(await rpc("getPreview", "GET", bookId)); assert.equal(preview.bookId, bookId); assert.ok(preview.sections.length > 0);
      assert.deepEqual(preview.sections.map(section => section.item_path), book.paths);
      const sample = await result(await rpc("loadDevicePage", "GET", { deviceId: "mapped-device", bookId }));
      assert.equal(sample.path, book.paths[1]); assert.equal(sample.bookId, bookId); assert.equal(sample.chapter, preview.sections[1].title);
      for (const deviceId of ["unmapped-device", "stale-device", "absent-device"]) assert.equal(await result(await rpc("loadDevicePage", "GET", { deviceId, bookId })), null);
      const assetPath = "/devices/content/" + bookId + "/11000/epub/" + encodePath(preview.sections[0].item_path);
      assert.equal((await get(assetPath, false)).status, 303);
      const asset = await get(assetPath); assert.equal(asset.status, 200); assert.ok((await asset.text()).includes('<base href="http://localhost/devices/content/'));
      for (const mode of ["00000", "01000", "10000", "11000"]) {
        const prefix = "/devices/content/" + bookId + "/" + mode + "/epub/";
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
      const initial = await result(await rpc("listTypesetProfiles", "GET")); assert.equal(initial.length, 1); assert.equal(initial[0].builtIn, true);
      const created = await result(await rpc("createTypesetProfile", "POST", input)); assert.ok(created.id);
      assert.equal(created.settings.stripFonts, true); assert.equal(created.settings.stripImages, true);
      const updated = await result(await rpc("updateTypesetProfile", "POST", { ...input, id: created.id, name: "已更新" })); assert.equal(updated.name, "已更新");
      const stored = (await result(await rpc("listTypesetProfiles", "GET")))[1]; assert.deepEqual(stored.settings, { ...settings, marginXUnit: "em", stripPageMargins: false, stripLineHeight: false, stripParagraphSpacing: false });
      const negative = { ...settings, marginX: -4.8, marginXUnit: "percent" };
      await result(await rpc("updateTypesetProfile", "POST", { ...input, id: created.id, settings: negative }));
      assert.deepEqual((await result(await rpc("listTypesetProfiles", "GET")))[1].settings, { ...negative, stripPageMargins: false, stripLineHeight: false, stripParagraphSpacing: false });
      assert.equal((await result(await rpc("listTypesetProfiles", "GET"))).length, 2);
      await result(await rpc("deleteTypesetProfile", "POST", { id: created.id }));
      assert.equal((await result(await rpc("listTypesetProfiles", "GET"))).length, 1);
      writeFileSync(join(root, "typeset-result.json"), JSON.stringify({ ok: true, pages }));
      } finally { await handler.shutdown(); }
    `);
    await promisify(execFile)(process.execPath, [script, fixture.root, fixture.id, signIn(fixture.library.db), resolve("dist/server")], { timeout: 20000 });
    const result = JSON.parse(readFileSync(join(fixture.root, "typeset-result.json"), "utf8"));
    expect(result.ok).toBe(true);
    const preview = parseHtml(result.pages.preview);
    expect(byRole(preview, "region", "设备预览")).toBeDefined();
    expect(byRole(preview, "button", "校准说明")).toBeDefined();
    expect(byLabel(preview, /^左右边距/).hasAttribute("disabled")).toBe(false);
    expect(byRole(preview, "group", "去掉书里自带的")).toBeDefined();
    expect(byRole(preview, "button", "去掉所有图片").getAttribute("aria-pressed")).toBe("false");
    expect(byRole(preview, "button", "自定义 CSS")).toBeDefined();
    expect(byRole(preview, "button", "另存为方案")).toBeDefined();
    for (const name of ["新建方案", "保存方案"]) expect(allByRole(preview, "button", name)).toHaveLength(0);
    const paging = byRole(preview, "group", "预览翻页");
    for (const name of ["上一页", "下一页"]) expect(byRole(paging, "button", name)).toBeDefined();
    const status = byRole(paging, "status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toContain("正在分页");
  } finally { fixture.cleanup(); }
});
