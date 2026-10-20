import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

const dir = process.argv[2];
process.env.BINDERY_LIBRARY_DIR = join(dir, "library");
process.env.BINDERY_DB_PATH = join(dir, "db.sqlite");
process.env.BINDERY_TEMPLATE_DIR = join(dir, "templates");
process.env.BINDERY_STAGE_DIR = join(dir, "stage");
process.env.BINDERY_RULES_DIR = ""; process.env.BINDERY_THEMES_DIR = "";
process.env.BINDERY_PASSWORD_HASH = "";
const { createProductionHandler } = await import("../../../scripts/production-handler.mjs");
const handler = await createProductionHandler();
let db;
try {
const anonymous = await handler(new Request("http://localhost/ingest"));
assert.equal(anonymous.status, 303);
assert.equal(anonymous.headers.get("Location"), "/login?next=/ingest");
db = new DatabaseSync(process.env.BINDERY_DB_PATH);
db.prepare("INSERT INTO sessions(session_id, created_at, last_seen) VALUES (?, ?, ?)").run("production-session", "2026", "2026");
const cookie = "bindery_session=production-session";
const get = (path, accept = "text/html") => handler(new Request("http://localhost" + path, { headers: { Cookie: cookie, Accept: accept } }));
const post = (path, body, accept = "text/html") => handler(new Request("http://localhost" + path, { method: "POST", body, headers: { Cookie: cookie, Accept: accept } }));
for (const [path, state] of [["/ingest", "closed"], ["/ingest?jobs_tab=all", "open"], ["/ingest?jobs_tab=failed&jobs_page=2", "open"], ["/ingest?jobs_page=1", "closed"]]) {
  const response = await get(path); assert.equal(response.status, 200, `${path}: ${response.headers.get("Location")} ${await response.clone().text()}`); assert.equal(response.headers.get("Cache-Control"), "no-store");
  const html = await response.text(); assert.match(html, /开始入库/); assert.match(html, /最近任务/);
  assert.match(html, new RegExp(`<dialog[^>]*id="jobs"[^>]*dialog-sheet[^>]*data-state="${state}"`));
  assert.match(html, new RegExp(`aria-controls="jobs" aria-expanded="${state === "open"}"`));
  assert.doesNotMatch(html, /<section[^>]*id="jobs"/); assert.doesNotMatch(html, /最近任务 · 0/);
}
const form = new FormData(); form.append("files", new File(["《生产测试》\n作者：生产作者\n\n第一章 开始\n正文"], "input.txt", { type: "text/plain" }));
const preview = await post("/ingest/preview", form, "application/json"); assert.equal(preview.status, 200); const previews = await preview.json(); assert.equal(previews[0].title, "生产测试"); assert.ok(previews[0].upload_token);
const invalidCss = await post("/ingest", new URLSearchParams({ upload_tokens: previews[0].upload_token, custom_css: "p{" }));
assert.equal(invalidCss.status, 200); const invalidCssHtml = await invalidCss.text(); assert.match(invalidCssHtml, /自定义 CSS 校验失败：CSS 花括号不匹配/); assert.match(invalidCssHtml, /p\{/);
assert.equal(db.prepare("SELECT count(*) AS n FROM jobs").get().n, 0);
assert.ok((await readFile(join(dir, "stage", previews[0].upload_token, "meta.json"))).length > 0);
const submitted = await post("/ingest", new URLSearchParams({ upload_tokens: previews[0].upload_token })); assert.equal(submitted.status, 303); assert.match(submitted.headers.get("Location"), /^\/ingest\?toast=/);
let job;
for (let n = 0; n < 80; n++) { job = db.prepare("SELECT * FROM jobs ORDER BY rowid DESC LIMIT 1").get(); if (job?.status !== "running") break; await setTimeout(100); }
assert.equal(job.status, "success", JSON.stringify(job));
const meta = db.prepare("SELECT * FROM books WHERE book_id = ?").get(job.book_id); assert.equal(meta.title, "生产测试"); assert.ok((await readFile(join(dir, "library", job.book_id, "book.epub"))).length > 0);
const partial = await get("/jobs/partial?tab=success", "application/json"); assert.equal(partial.status, 200); assert.equal((await partial.json()).jobs[0].book_title, "生产测试");
const htmlPartial = await get("/jobs/partial?tab=success"); assert.match(await htmlPartial.text(), /jobs-section/);
assert.equal((await get("/jobs/partial?page=no")).status, 422);
for (const [path, target] of [["/jobs", "/ingest?jobs_tab=all&jobs_page=1#jobs"], ["/jobs?tab=failed&page=2", "/ingest?jobs_tab=failed&jobs_page=2#jobs"], ["/jobs?page=no", "/ingest?jobs_tab=all&jobs_page=no#jobs"], ["/jobs?page=", "/ingest?jobs_tab=all&jobs_page=#jobs"]]) {
  const legacy = await get(path); assert.equal(legacy.status, 303); assert.equal(legacy.headers.get("Location"), target);
}
for (const page of ["no", "1.5", "1e3", ""]) assert.equal((await get(`/ingest?jobs_page=${page}`)).status, 422);
const extraParamsPage = await get("/ingest?jobs_tab=bad&jobs_page=1.0&custom=value"); assert.equal(extraParamsPage.status, 200); await extraParamsPage.text();
const allJobs = await get("/jobs/partial?tab=all", "application/json"); assert.equal((await allJobs.json()).total_jobs, 1);
const invalid = await post("/book/invalid/regenerate", new URLSearchParams()); assert.equal(invalid.status, 404);
const regen = await post(`/book/${job.book_id}/regenerate`, new URLSearchParams({ next: "//evil.test" })); assert.equal(regen.status, 303); assert.equal(regen.headers.get("Location"), "/ingest?jobs_tab=running#jobs");
for (let n = 0; n < 80; n++) { const active = db.prepare("SELECT count(*) AS n FROM jobs WHERE status = 'running'").get(); if (!active.n) break; await setTimeout(100); }
assert.equal(db.prepare("SELECT count(*) AS n FROM jobs WHERE status = 'success'").get().n, 2);
const coverBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X4D1kAAAAASUVORK5CYII=", "base64");
const edit = new FormData(); edit.set("title", "生产写回"); edit.set("author", "生产作者"); edit.set("theme_template", "default"); edit.set("custom_css", "p {color:blue}"); edit.set("strip_original_css", "on"); edit.set("cover_file", new File([coverBytes], "new.png"));
const edited = await post(`/book/${job.book_id}/edit`, edit, "application/json"); assert.equal(edited.status, 200); assert.equal((await edited.json()).queued, true);
let editJob;
for (let n = 0; n < 80; n++) { editJob = db.prepare("SELECT * FROM jobs WHERE action = 'edit-writeback' ORDER BY rowid DESC LIMIT 1").get(); if (editJob?.status !== "running") break; await setTimeout(100); }
assert.equal(editJob.status, "success", JSON.stringify(editJob));
const savedMeta = db.prepare("SELECT * FROM books WHERE book_id = ?").get(job.book_id); assert.equal(savedMeta.title, "生产写回"); assert.equal(savedMeta.cover_file, "cover.png"); assert.equal(savedMeta.status, "synced");
assert.deepEqual(await readFile(join(dir, "library", job.book_id, "cover.png")), coverBytes);
const missingJob = await post("/jobs/missing/retry", new URLSearchParams()); assert.equal(missingJob.status, 404); assert.deepEqual(await missingJob.json(), { detail: "任务不存在" });
assert.equal((await post("/jobs/cleanup-invalid", new URLSearchParams({ tab: "failed" }))).headers.get("Location"), "/ingest?jobs_tab=failed#jobs");
const completedPage = await get("/ingest?jobs_tab=success"); assert.equal(completedPage.status, 200); await completedPage.text();
db.close();
await writeFile(join(dir, "result.json"), JSON.stringify({ passed: true }));
console.log("ingest production SSR/HTTP/worker passed");


} finally {
  if (db?.isOpen) db.close();
  await handler.shutdown();
}
