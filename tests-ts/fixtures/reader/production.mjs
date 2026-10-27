import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { createProductionHandler } from "../../../scripts/production-handler.mjs";
const [root, id, session] = process.argv.slice(2);
for (const key of ["BINDERY_LIBRARY_DIR", "BINDERY_DB_PATH", "BINDERY_PASSWORD_HASH", "BINDERY_PUBLIC_ORIGIN", "BINDERY_RULES_DIR", "BINDERY_THEMES_DIR", "BINDERY_TEMPLATE_DIR"]) { process.env[key] = ""; process.env[`${key}_FILE`] = ""; }
process.env.BINDERY_LIBRARY_DIR = join(root, "library"); process.env.BINDERY_DB_PATH = join(root, "db.sqlite"); process.env.BINDERY_TEMPLATE_DIR = join(root, "templates");
const handler = await createProductionHandler();
let db;
try {
const get = (path, auth = true, method = "GET", body) => handler(new Request(`http://localhost${path}`, { method, body, headers: { Cookie: auth ? `bindery_session=${session}` : "", "Content-Type": "application/json" } }));
for (const suffix of ["preview", "preview/0", "search?q=needle", "epub/section_0001.xhtml"]) {
  const response = await get(`/book/${id}/${suffix}`, false); assert.equal(response.status, 303, suffix); assert.match(response.headers.get("location"), /^\/login\?next=/);
}
const first = await get(`/book/${id}/preview?return_to=%2Fjobs%3Ftab%3Dsuccess`);
assert.equal(first.status, 303); assert.equal(first.headers.get("location"), `/book/${id}/preview/0?resume=1&return_to=%2Fjobs%3Ftab%3Dsuccess`);
assert.match(first.headers.get("cache-control"), /no-store/); assert.equal(first.headers.get("cdn-cache-control"), "no-store");
const book = JSON.parse(readFileSync(join(root, "production-paths.json"), "utf8"));
const encodePath = path => path.split("/").map(part => encodeURIComponent(part).replace(/[!'()*~]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
const resourcePath = path => `/book/${id}/epub/${encodePath(path)}`;
const save = await get(`/book/${id}/progress`, true, "POST", JSON.stringify({ section: 1, page: 3, page_count: 8 }));
assert.equal(save.status, 200); assert.deepEqual(await save.json(), { ok: true, book_id: id, section: 1, page: 3, page_count: 8 });
db = new DatabaseSync(process.env.BINDERY_DB_PATH); assert.equal(db.prepare("SELECT page FROM reader_progress WHERE book_id=?").get(id).page, 3); db.close();
const page = await get(`/book/${id}/preview/0?resume=1&return_to=%2Fjobs`);
assert.equal(page.status, 200, JSON.stringify(Object.fromEntries(page.headers))); assert.match(page.headers.get("cache-control"), /no-store/); assert.equal(page.headers.get("cdn-cache-control"), "no-store");
const html = await page.text();
assert.doesNotMatch(html, /<header class="site-header"|aria-label="主导航"|aria-label="手机导航"/);
assert.match(html, /class="reader-main"/); assert.match(html, /href="#app-content"/); assert.match(html, /id="app-content"[^>]*tabindex="-1"/);
assert.match(html, /aria-live="polite"/);
const ordinary = await get(`/book/${id}`); assert.equal(ordinary.status, 200);
const ordinaryHtml = await ordinary.text(); assert.match(ordinaryHtml, /aria-label="主导航"/); assert.match(ordinaryHtml, /aria-label="手机导航"/); assert.match(ordinaryHtml, /class="page-shell"/); assert.match(ordinaryHtml, /class="app-main"/); assert.doesNotMatch(ordinaryHtml, /app-frame/);
 assert.match(html, /全文检索/); assert.match(html, /sandbox="allow-same-origin"/); assert.doesNotMatch(html, /allow-scripts|srcdoc=/); assert.doesNotMatch(html, new RegExp(root));
const search = await get(`/book/${id}/search?q=needle&limit=1&offset=0`); assert.equal(search.status, 200); const results = await search.json(); assert.equal(results.hits.length, 1); assert.equal(results.has_more, true); assert.equal(results.next_offset, 1);
assert.ok(html.includes(resourcePath(book.paths[1])), "resume iframe must encode every member segment");
for (const path of [...book.paths, book.image, book.css, book.importedCss, book.font, ...["%2e%2e", "%2F", "#", "?", "a:b", "::|"].map(name => `OEBPS/Images/${name}`)]) {
  const response = await get(resourcePath(path));
  assert.equal(response.status, 200, path);
  assert.match(response.headers.get("content-security-policy"), /sandbox allow-same-origin; default-src 'none'; script-src 'none'/);
  if (path === book.paths[0]) {
    const content = await response.text();
    for (const target of [book.image, book.css, book.paths[1]]) assert.ok(content.includes(resourcePath(target)), target);
    assert.ok(content.includes(resourcePath(path) + "#note"));
    assert.doesNotMatch(content, /<script|parent.attack|<form/);
  } else if (path === book.css) {
    const css = await response.text();
    for (const target of [book.image, book.importedCss, book.font]) assert.ok(css.includes(resourcePath(target)), target);
  } else await response.arrayBuffer();
}
assert.equal((await get(resourcePath(book.paths[0]), true, "HEAD")).status, 200);
for (const path of ["%00x", "a%5Cb", "a%0Ab", "a%2F..%2Fx", "absent.xhtml"]) assert.equal((await get(`/book/${id}/epub/${path}`)).status, 404);
const itemPath = "Text/第一 章.xhtml";
const item = await get(`/book/${id}/epub/${itemPath.split("/").map(encodeURIComponent).join("/")}`);
assert.equal(item.status, 200); assert.equal(item.headers.get("content-type"), "text/html; charset=utf-8"); assert.match(item.headers.get("content-security-policy"), /sandbox allow-same-origin/); assert.match(item.headers.get("content-security-policy"), /script-src 'none'/);
assert.equal(item.headers.get("cache-control"), "private, no-cache, must-revalidate"); assert.equal(item.headers.get("cloudflare-cdn-cache-control"), "no-store");
const itemHtml = await item.text(); assert.match(itemHtml, /隔离正文/); assert.doesNotMatch(itemHtml, /<script|onerror|http-equiv|<iframe|<form/);
assert.equal((await get(`/book/${id}/epub/${encodeURIComponent("Text/../book.json")}`)).status, 404);
assert.equal((await get(`/book/${id}/epub/%252e%252e/book.json`)).status, 404);
assert.equal((await get(`/book/${id}/progress`, true, "POST", "null")).status, 400);
assert.equal((await get(`/book/${id}/search?limit=101`)).status, 422);
assert.equal((await get(`/book/${id}/epub/absent.xhtml`)).status, 404);
const missingSection = await get(`/book/${id}/preview/99999`);
assert.equal(missingSection.status, 404);
assert.match(await missingSection.text(), /章节不存在/);
const missingBook = await get(`/book/${"e".repeat(32)}/preview/0`);
assert.equal(missingBook.status, 404); assert.match(await missingBook.text(), /书籍不存在/);
assert.equal((await get(`/book/${id}/preview/bad`)).status, 422);
writeFileSync(join(root, "production-result.json"), JSON.stringify({ ok: true }));

} finally {
  if (db?.isOpen) db.close();
  await handler.shutdown();
}
