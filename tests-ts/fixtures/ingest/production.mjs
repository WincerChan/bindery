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
const anonymous = await handler(new Request("http://localhost/ingest"));
assert.equal(anonymous.status, 303);
assert.equal(anonymous.headers.get("Location"), "/login?next=/ingest");
const db = new DatabaseSync(process.env.BINDERY_DB_PATH);
db.prepare("INSERT INTO sessions(session_id, created_at, last_seen) VALUES (?, ?, ?)").run("production-session", "2026", "2026");
const cookie = "bindery_session=production-session";
const get = (path, accept = "text/html") => handler(new Request("http://localhost" + path, { headers: { Cookie: cookie, Accept: accept } }));
const post = (path, body, accept = "text/html") => handler(new Request("http://localhost" + path, { method: "POST", body, headers: { Cookie: cookie, Accept: accept } }));
for (const [path, text] of [["/ingest", "开始入库"], ["/jobs", "查看转换与写回的进度。"]]) {
  const response = await get(path); assert.equal(response.status, 200, `${path}: ${response.headers.get("Location")} ${await response.clone().text()}`); assert.equal(response.headers.get("Cache-Control"), "no-store"); assert.match(await response.text(), new RegExp(text));
}
const form = new FormData(); form.append("files", new File(["《生产测试》\n作者：生产作者\n\n第一章 开始\n正文"], "input.txt", { type: "text/plain" }));
const preview = await post("/ingest/preview", form, "application/json"); assert.equal(preview.status, 200); const previews = await preview.json(); assert.equal(previews[0].title, "生产测试"); assert.ok(previews[0].upload_token);
const submitted = await post("/ingest", new URLSearchParams({ upload_tokens: previews[0].upload_token })); assert.equal(submitted.status, 303); assert.match(submitted.headers.get("Location"), /^\/ingest\?toast=/);
let job;
for (let n = 0; n < 80; n++) { job = db.prepare("SELECT * FROM jobs ORDER BY rowid DESC LIMIT 1").get(); if (job?.status !== "running") break; await setTimeout(100); }
assert.equal(job.status, "success", JSON.stringify(job));
const meta = db.prepare("SELECT * FROM books WHERE book_id = ?").get(job.book_id); assert.equal(meta.title, "生产测试"); assert.ok((await readFile(join(dir, "library", job.book_id, "book.epub"))).length > 0);
const partial = await get("/jobs/partial?tab=success", "application/json"); assert.equal(partial.status, 200); assert.equal((await partial.json()).jobs[0].book_title, "生产测试");
const htmlPartial = await get("/jobs/partial?tab=success"); assert.match(await htmlPartial.text(), /jobs-section/);
assert.equal((await get("/jobs/partial?page=no")).status, 422);
const invalidJobsPage = await get("/jobs?page=no"); assert.equal(invalidJobsPage.status, 422);
const extraParamsPage = await get("/jobs?tab=bad&page=1.0&custom=value"); assert.equal(extraParamsPage.status, 200); await extraParamsPage.text();
const invalid = await post("/book/invalid/regenerate", new URLSearchParams()); assert.equal(invalid.status, 404);
const regen = await post(`/book/${job.book_id}/regenerate`, new URLSearchParams({ next: "//evil.test" })); assert.equal(regen.status, 303); assert.equal(regen.headers.get("Location"), "/jobs?tab=running");
for (let n = 0; n < 80; n++) { const active = db.prepare("SELECT count(*) AS n FROM jobs WHERE status = 'running'").get(); if (!active.n) break; await setTimeout(100); }
assert.equal(db.prepare("SELECT count(*) AS n FROM jobs WHERE status = 'success'").get().n, 2);
assert.equal((await post("/jobs/missing/retry", new URLSearchParams())).status, 404);
assert.equal((await post("/jobs/cleanup-invalid", new URLSearchParams({ tab: "failed" }))).headers.get("Location"), "/jobs?tab=failed");
const completedPage = await get("/jobs?tab=success"); assert.equal(completedPage.status, 200); await completedPage.text();
db.close();
await writeFile(join(dir, "result.json"), JSON.stringify({ passed: true }));
console.log("ingest production SSR/HTTP/worker passed");

