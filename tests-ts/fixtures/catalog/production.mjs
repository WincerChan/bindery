import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hash } from "@node-rs/argon2";
import { createProductionHandler } from "../../../scripts/production-handler.mjs";

const root = await mkdtemp(join(tmpdir(), "bindery-catalog-http-"));
try {
  for (const key of ["BINDERY_LIBRARY_DIR", "BINDERY_DB_PATH", "BINDERY_PASSWORD_HASH", "BINDERY_RULES_DIR", "BINDERY_THEMES_DIR", "BINDERY_TEMPLATE_DIR"]) { delete process.env[key]; delete process.env[key + "_FILE"]; }
  Object.assign(process.env, { BINDERY_LIBRARY_DIR: join(root, "library"), BINDERY_DB_PATH: join(root, "data.db"), BINDERY_TEMPLATE_DIR: join(root, "templates"), BINDERY_PASSWORD_HASH: await hash("catalog-password", { memoryCost: 8192, timeCost: 1 }) });
  const handler = await createProductionHandler();
  let cookie = "";
  const request = async (path, fields, accept = "text/html") => {
    if (process.env.BINDERY_CATALOG_TRACE) console.error(fields ? "POST" : "GET", path);
    const response = await handler(new Request("http://localhost" + path, { method: fields ? "POST" : "GET", headers: { Cookie: cookie, Accept: accept }, ...(fields ? { body: new URLSearchParams(fields) } : {}) }));
    if (process.env.BINDERY_CATALOG_TRACE) console.error("STATUS", response.status);
    // Drain SSR streams, including 404s, so router cleanup timers do not outlive the probe.
    return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
  };
  const pages = ["/rules", "/rules/default/editor", "/themes/default/editor", "/tracker", "/wishlist", "/tracker/export", "/wishlist/export", "/tracker/duplicate-check", "/wishlist/duplicate-check"];
  const posts = ["/rules/new", "/rules/default/editor", "/rules/default/delete", "/rules/test", "/themes/new", "/themes/default/editor", "/themes/default/delete", "/tracker", "/wishlist", ...["tracker", "wishlist"].flatMap(f => [`/${f}/${"a".repeat(32)}/update`, `/${f}/${"a".repeat(32)}/delete`])];
  for (const path of pages) assert.equal((await request(path)).status, 303, `Anonymous GET ${path}`);
  for (const path of posts) assert.equal((await request(path, {})).status, 303, `Anonymous POST ${path}`);
  const login = await request("/login", { password: "catalog-password" });
  cookie = login.headers.getSetCookie()[0].split(";", 1)[0];
  for (const path of pages) {
    const response = await request(path); assert.equal(response.status, 200, `GET ${path}`); assert.equal(response.headers.get("cache-control"), "no-store");
    if (!path.includes("export") && !path.includes("duplicate-check")) { const html = await response.text(); assert.match(html, /id="app-content"/); assert.doesNotMatch(html, /服务器内部错误/); }
  }
  for (const path of ["/rules/missing/editor", "/themes/missing/editor"]) { const response = await request(path); assert.equal(response.status, 404, path); const html = await response.text(); assert.match(html, path.startsWith("/rules") ? /规则不存在/ : /主题不存在/); assert.match(html, /role="alert"/); assert.match(html, /返回书库/); }
  const createdRule = await request("/rules/new", {}); assert.equal(createdRule.status, 303); const ruleId = new URL(createdRule.headers.get("location"), "http://localhost").searchParams.get("rule_id");
  assert.match(ruleId, /^custom-[a-f0-9]{8}$/);
  const ruleSaved = await request(`/rules/${ruleId}/editor`, { config_json: JSON.stringify({ id: ruleId, name: "规则", chapter_patterns: ["^第.*章.*$"], volume_patterns: [], special_headings: [] }) }); assert.equal(ruleSaved.status, 200); assert.match(await ruleSaved.text(), /已保存/);
  const ruleBad = await request(`/rules/${ruleId}/editor`, { config_json: "{bad" }); assert.equal(ruleBad.status, 200); assert.match(await ruleBad.text(), /JSON 解析失败/);
  const preview = await request("/rules/test", { sample: "第一章 开始\n正文", rule_template: ruleId }); assert.equal(preview.status, 200); assert.match(await preview.text(), /目录预览/);
  const jsonPreview = await request("/rules/test", { sample: "第一章 开始\n正文", rule_template: ruleId }, "application/json"); assert.equal((await jsonPreview.json()).chapters, 1);
  const defaultDelete = await request("/rules/default/delete", {}); assert.equal(defaultDelete.status, 400); assert.deepEqual(await defaultDelete.json(), { detail: "默认模板不可删除" });
  assert.equal((await request(`/rules/${ruleId}/delete`, {})).status, 303);
  const htmxNew = await handler(new Request("http://localhost/themes/new", { method: "POST", headers: { Cookie: cookie, "HX-Request": "true" } })); assert.equal(htmxNew.status, 200); const themeId = new URL(htmxNew.headers.get("HX-Redirect"), "http://localhost").searchParams.get("theme_id");
  const themeBad = await request(`/themes/${themeId}/editor`, { css: "p{" }); assert.equal(themeBad.status, 200); assert.match(await themeBad.text(), /主题 CSS 校验失败：CSS 花括号不匹配/);
  const themeSaved = await request(`/themes/${themeId}/editor`, { css: "p { color: red }" }, "application/json"); assert.equal((await themeSaved.json()).saved, true);
  const themePage = await request(`/rules?tab=themes&theme_id=${themeId}`); assert.match(await themePage.text(), /<iframe[^>]*\ssandbox(?:="")?(?:\s|>)/);
  assert.equal((await request(`/themes/${themeId}/delete`, {})).status, 303);
  assert.equal((await request("/tracker", {})).status, 400);
  const added = await request("/wishlist", { title: "三体", author: "刘慈欣", tags: "科幻", read_status: "reading", rating: "5", next: "/tracker?q=三体" }); assert.equal(added.status, 303); assert.match(added.headers.get("location"), /q=/);
  const duplicate = await request("/wishlist/duplicate-check?title=三体&author=刘慈欣"); const payload = await duplicate.json(); assert.equal(payload.exists, true); const wishId = payload.matches[0].id;
  assert.equal((await request("/tracker/duplicate-check?limit=0")).status, 422); assert.equal((await request("/tracker/duplicate-check?limit=")).status, 422);
  const repeated = await request("/tracker", { title: "三体" }); assert.match(repeated.headers.get("location"), /duplicate=/);
  const edited = await request(`/wishlist/${wishId}/update`, { title: "三体", author: "刘慈欣", rating: "4", read_status: "read", book_status: "completed", comment: '重读\n"很好"' }); assert.equal(edited.status, 303);
  const listed = await request("/tracker?read_filter=read"); const listedHtml = await listed.text(); assert.match(listedHtml, /三体/); assert.match(listedHtml, /重读/);
  for (const family of ["tracker", "wishlist"]) { const exported = await request(`/${family}/export?read_filter=read`); assert.match(exported.headers.get("content-disposition"), /^attachment; filename="bindery-tracker-/); const bytes = Buffer.from(await exported.arrayBuffer()); assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191]); assert.match(bytes.toString("utf8"), /三体,刘慈欣,4/); }
  const removed = await request(`/wishlist/${wishId}/delete`, { next: "//evil.test" }); assert.equal(removed.headers.get("location"), "/tracker");
  const missingWish = await request(`/tracker/${wishId}/update`, { title: "missing" });
  assert.equal(missingWish.status, 404); assert.deepEqual(await missingWish.json(), { detail: "追踪条目不存在" });
  console.log("Catalog production fetch checks passed: pages, aliases, authentication, CRUD, HTML/JSON, CSV and errors");
  if (process.argv[2]) await writeFile(process.argv[2], "Catalog production fetch checks passed");
} finally { await rm(root, { recursive: true, force: true }); }
