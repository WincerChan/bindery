import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createProductionHandler } from "./production-handler.mjs";

const dir = await mkdtemp(join(tmpdir(), "bindery-ssr-"));
const previous = process.env.BINDERY_DB_PATH;
try {
  const path = join(dir, "fixture.db"),
    db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE books (book_id TEXT PRIMARY KEY); INSERT INTO books VALUES ('a'), ('b'), ('c')",
  );
  db.close();
  const before = await readFile(path);
  process.env.BINDERY_DB_PATH = path;
  const handler = await createProductionHandler();
  const response = await handler(new Request("http://localhost/"));
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /data-testid="book-count">3<\/strong>/);
  assert.match(html, /已连接现有书库/);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(
    (m) => m[1],
  );
  assert.ok(assets.some((p) => p.endsWith(".css")));
  assert.ok(assets.some((p) => p.endsWith(".js")));
  for (const asset of new Set(assets)) {
    const result = await handler(new Request("http://localhost" + asset));
    assert.equal(result.status, 200, asset);
    assert.ok((await result.arrayBuffer()).byteLength > 0);
  }
  // Exercise the real client RPC URL as well as the in-process SSR invocation.
  const server = await readFile(
    new URL("../dist/server/server.js", import.meta.url),
    "utf8",
  );
  const id =
    /"([a-f0-9]{64})":\s*\{\s*functionName: "getBookCount_createServerFn_handler"/.exec(
      server,
    )?.[1];
  assert.ok(id, "built server function manifest");
  const rpc = await handler(
    new Request(
      `http://localhost/_serverFn/data/${id}?args=${encodeURIComponent(JSON.stringify([{ method: "GET", context: {} }]))}`,
      {
        headers: {
          Origin: "http://localhost",
          "Sec-Fetch-Site": "same-origin",
        },
      },
    ),
  );
  assert.equal(rpc.status, 200);
  assert.deepEqual((await rpc.json()).result, { count: 3, missing: false });
  assert.deepEqual(await readFile(path), before);
  process.env.BINDERY_DB_PATH = join(dir, "absent", "missing.db");
  const missing = await handler(new Request("http://localhost/"));
  assert.equal(missing.status, 200);
  const empty = await missing.text();
  assert.match(empty, /data-testid="book-count">0<\/strong>/);
  assert.match(empty, /尚未找到书库数据库/);
  const hidden = await handler(
    new Request("http://localhost/.vite/manifest.json"),
  );
  assert.equal(hidden.status, 404);
  await hidden.text(); // Drain the SSR stream so Start can release its request timeout.
  console.log(
    "Production SSR, missing DB, read-only SQLite, client RPC and built assets: PASS (no sockets)",
  );
} finally {
  if (previous === undefined) delete process.env.BINDERY_DB_PATH;
  else process.env.BINDERY_DB_PATH = previous;
  await rm(dir, { recursive: true, force: true });
}
