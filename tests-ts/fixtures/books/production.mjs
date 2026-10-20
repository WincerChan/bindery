import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { unzipSync } from "fflate";
import { createProductionHandler } from "../../../scripts/production-handler.mjs";
const [root, cookie] = process.argv.slice(2),
  id = "a".repeat(32);
for (const name of [
  "BINDERY_LIBRARY_DIR",
  "BINDERY_DB_PATH",
  "BINDERY_TEMPLATE_DIR",
  "BINDERY_RULES_DIR",
  "BINDERY_THEMES_DIR",
  "BINDERY_PASSWORD_HASH",
  "BINDERY_PUBLIC_ORIGIN",
  "BINDERY_WEBAUTHN_RP_ID",
]) {
  process.env[name] = "";
  process.env[`${name}_FILE`] = "";
}
process.env.BINDERY_LIBRARY_DIR = join(root, "library");
process.env.BINDERY_DB_PATH = join(root, "data.db");
process.env.BINDERY_TEMPLATE_DIR = join(root, "templates");
let transportCalls = 0;
globalThis.fetch = async (url, init) => {
  transportCalls++;
  assert.ok(String(url).startsWith("https://book.douban.com/"));
  assert.equal(
    new Headers(init?.headers).get("User-Agent")?.includes("Chrome/123"),
    true,
  );
  return String(url).includes("subject_suggest")
    ? Response.json([{ title: "线上书", author_name: "作者", id: "123" }])
    : new Response(
        `<script type="application/ld+json">{"@type":"Book","name":"线上书","author":{"name":"作者"},"description":"线上简介","image":"https://img.test/cover.jpg"}</script>`,
      );
};
// Python's flow oracle pauses its worker. Hold the real consumer lock so this
// probe observes the same pending metadata and does not race archive/delete.
const consumerLock = join(root, "library", ".ingest-queue", ".consumer");
mkdirSync(consumerLock, { recursive: true });
writeFileSync(join(consumerLock, "pid"), String(process.pid));
const handler = await createProductionHandler();
async function request(path, values, headers = {}, anonymous = false) {
  const form =
    values instanceof FormData ? values : new URLSearchParams(values);
  const response = await handler(
    new Request("http://localhost" + path, {
      method: values === undefined ? "GET" : "POST",
      headers: { Cookie: anonymous ? "" : cookie, ...headers },
      body: values === undefined ? undefined : form,
    }),
  );
  const bytes = await response.arrayBuffer();
  return new Response(bytes, {
    status: response.status,
    headers: response.headers,
  });
}
const base = "/book/" + id,
  db = new DatabaseSync(join(root, "data.db"), { timeout: 5000 });
const meta = () => db.prepare("SELECT * FROM books WHERE book_id=?").get(id);
const wish = () =>
  db.prepare("SELECT * FROM wishlist WHERE library_book_id=?").get(id);
const out = {};
try {
  const anon = await request(base, undefined, {}, true);
  assert.equal(anon.status, 303);
  const anonPost = await request(base + "/read", { read: "1" }, {}, true);
  assert.equal(anonPost.status, 303);
  assert.equal(meta().read, 0);
  let response = await request(base + "?return_to=%2F%3Fpage%3D3");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /下载 EPUB/);
  assert.match(html, /阅读状态/);
  assert.match(html, /return_to=%2F%3Fpage%3D3/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  response = await request(base + "/edit");
  assert.equal(response.status, 200);
  const editHtml = await response.text();
  assert.match(editHtml, /保存并写回/);
  assert.equal((editHtml.match(/书目<\/span>/g) || []).length, 0);
  assert.match(editHtml, /name="custom_css"/);
  const editPartial = await request(
    base + "/edit?return_to=%2F%3Fpage%3D3",
    undefined,
    { "HX-Request": "true" },
  );
  assert.equal(editPartial.status, 200);
  const partialHtml = await editPartial.text();
  assert.match(partialHtml, /id="meta-panel"/);
  assert.doesNotMatch(partialHtml, /<!doctype|<html/i);
  assert.match(partialHtml, /name="return_to" value="\/\?page=3"/);
  const invalid = await request(
    base + "/edit",
    { title: "无效草稿", custom_css: "a{" },
    { Accept: "application/json" },
  );
  assert.equal(invalid.status, 200);
  assert.match((await invalid.json()).page.error, /自定义 CSS 校验失败/);
  assert.equal(meta().title, "示例书");
  const invalidHtml = await request(base + "/edit", {
    title: "无效草稿",
    custom_css: "a{",
  });
  assert.equal(invalidHtml.status, 200);
  const invalidBody = await invalidHtml.text();
  assert.match(invalidBody, /无效草稿/);
  assert.match(invalidBody, /stylesheet/);
  const lookup = await request(
    base + "/metadata/fetch",
    {
      title: "示例书",
      author: "作者",
      series: "手填系列",
      rating: "4",
      return_to: "/?page=3",
    },
    { Accept: "application/json" },
  );
  assert.equal(lookup.status, 200);
  const draft = (await lookup.json()).page;
  assert.equal(draft.book.title, "线上书");
  assert.equal(draft.book.series, "手填系列");
  assert.equal(draft.book.rating, 4);
  assert.equal(draft.lookup_result.cover_url, "https://img.test/cover.jpg");
  assert.equal(meta().title, "示例书");
  assert.equal(transportCalls, 2);
  const missing = await request("/book/invalid/read", { read: "1" });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { detail: "书籍不存在" });
  response = await request(base + "/read", {
    read: " YES ",
    next: "/?page=2#ignored",
  });
  assert.equal(response.status, 303);
  out.read = {
    status: response.status,
    location: response.headers.get("location"),
    read: Boolean(meta().read),
    updated_at: meta().updated_at,
    epub_updated_at: meta().epub_updated_at,
    status_value: meta().status,
    tracker_read: wish().read_status,
  };
  const rich = await request(
    base + "/edit",
    { title: "示例书", strip_original_css: "1" },
    { Accept: "application/json" },
  );
  assert.equal(rich.status, 200);
  assert.equal((await rich.json()).queued, true);
  assert.equal(meta().title, "示例书");
  response = await request(base + "/edit", {
    title: " 新书 ",
    author: " 新作者 ",
    language: "",
    description: " 简介 ",
    series: " 系列 ",
    publisher: " 社 ",
    tags: "一, 二，二",
    published: "2024-01-02",
    isbn: "1234567890",
    rating: "9",
    rule_template: "ignored",
    theme_template: "__book__",
    custom_css: " body {color:red;} ",
    return_to: "/?page=3",
  });
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /toast_kind=success/);
  assert.equal(
    new URL(response.headers.get("location"), "http://local").searchParams.get(
      "return_to",
    ),
    "/?page=3",
  );
  out.edit = Object.fromEntries(
    [
      "title",
      "author",
      "language",
      "description",
      "series",
      "publisher",
      "published",
      "isbn",
      "rating",
      "rule_template",
      "theme_template",
      "custom_css",
      "status",
    ].map((k) => [k, meta()[k]]),
  );
  out.edit.tags = JSON.parse(meta().tags_json);
  out.edit.read = Boolean(meta().read);
  out.edit.job_action = db.prepare("SELECT action FROM jobs").get().action;
  out.edit.tracker_rating = wish().rating;
  out.edit.tracker_title = wish().title;
  out.edit.status_code = response.status;
  const file = new FormData();
  file.set(
    "cover",
    new File(
      [Buffer.from(readFileSync(join(root, "png.hex"), "utf8"), "hex")],
      "cover.png",
    ),
  );
  response = await request(base + "/cover/upload", file);
  assert.equal(response.status, 303);
  const entries = unzipSync(
      readFileSync(join(root, "library", id, "book.epub")),
    ),
    cover = Object.entries(entries).find(([name]) =>
      name.endsWith("/cover.png"),
    );
  assert.ok(cover);
  out.cover = {
    status: response.status,
    location: response.headers.get("location"),
    bytes: Buffer.from(cover[1]).toString("hex"),
    filename: meta().cover_file,
    synced: meta().status === "synced",
    same_time: meta().updated_at === meta().epub_updated_at,
  };
  response = await request(base + "/cover/extract", {});
  assert.equal(response.status, 303);
  const coverGet = await request(base + "/cover");
  assert.equal(coverGet.status, 200);
  assert.equal(
    coverGet.headers.get("Cache-Control"),
    "private, max-age=604800, immutable",
  );
  response = await request(
    base + "/read",
    { read: "1", next: base + "?return_to=%2F%3Fpage%3D3" },
    { "HX-Request": "true" },
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /标记未读/);
  response = await request(
    base + "/edit",
    {
      title: "新书",
      author: "新作者",
      rating: "5",
      theme_template: "__book__",
    },
    { "HX-Request": "true" },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("HX-Redirect"), null);
  assert.match(response.headers.get("HX-Trigger"), /bindery:toast/);
  assert.match(await response.text(), /下载 EPUB/);
  const oversized = await request(
    base + "/cover/upload",
    {},
    { "Content-Length": String(23 * 1024 * 1024) },
  );
  assert.equal(oversized.status, 413);
  const malformed = await request(
    base + "/edit",
    { title: "未保存" },
    { "Content-Type": "application/json" },
  );
  assert.equal(malformed.status, 400);
  const badUrl = await request(base + "/cover/url", {
    cover_url: "file:///etc/passwd",
  });
  assert.equal(badUrl.status, 400);
  const badImage = new FormData();
  badImage.set("cover", new File(["not an image"], "fake.png"));
  assert.equal((await request(base + "/cover/upload", badImage)).status, 415);
  const externalNext = await request(base + "/read", {
    read: "1",
    next: "https://evil.example",
  });
  assert.equal(externalNext.headers.get("location"), base);
  response = await request(base + "/archive", { next: "/?q=书&page=4" });
  out.archive = {
    status: response.status,
    location: response.headers.get("location"),
    exists: existsSync(join(root, "library", "archive", id)),
    archived: Boolean(meta().archived),
  };
  assert.equal((await request(base)).status, 404);
  mkdirSync(join(root, "library", id));
  assert.equal((await request(base + "/restore", {})).status, 409);
  const { rmSync } = await import("node:fs");
  rmSync(join(root, "library", id), { recursive: true });
  // Explicit next keeps the legacy Python flow comparable; defaults are tested separately.
  response = await request(base + "/restore", { next: "/" });
  out.restore = {
    status: response.status,
    location: response.headers.get("location"),
    exists: existsSync(join(root, "library", id)),
    archived: Boolean(meta().archived),
  };
  response = await request(base + "/delete", { next: "/archive" });
  out.delete = {
    status: response.status,
    location: response.headers.get("location"),
    exists: existsSync(join(root, "library", id)),
    tracker_exists: Boolean(wish()),
  };
  assert.equal(
    (await request(base + "/delete", {}, { "HX-Request": "true" })).status,
    200,
  );
  assert.equal((await request("/book/invalid/delete", {})).status, 404);
  writeFileSync(join(root, "result.json"), JSON.stringify(out));
} finally {
  db.close();
  await handler.shutdown();
}
