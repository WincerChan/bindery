import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it.runIf(existsSync("dist/server/server.js"))("serves neutral Kindle SSR and authenticated profile RPC CRUD through the production handler without sockets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bindery-kindle-ui-production-"));
  const code = `
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hash } from ${JSON.stringify(pathToFileURL(resolve("node_modules/@node-rs/argon2/index.js")).href)};
import { createProductionHandler } from ${JSON.stringify(pathToFileURL(resolve("scripts/production-handler.mjs")).href)};
const root = ${JSON.stringify(directory)};
for (const key of ['BINDERY_LIBRARY_DIR', 'BINDERY_DB_PATH', 'BINDERY_PASSWORD_HASH', 'BINDERY_RULES_DIR', 'BINDERY_THEMES_DIR', 'BINDERY_TEMPLATE_DIR', 'BINDERY_PUBLIC_ORIGIN', 'BINDERY_WEBAUTHN_RP_ID']) {
  process.env[key] = ''; process.env[key + '_FILE'] = '';
}
Object.assign(process.env, { BINDERY_LIBRARY_DIR: join(root, 'library'), BINDERY_DB_PATH: join(root, 'db.sqlite'), BINDERY_TEMPLATE_DIR: join(root, 'templates'), BINDERY_PASSWORD_HASH: await hash('kindle-ui-password', { memoryCost: 8192, timeCost: 1 }) });
const handler = await createProductionHandler();
try {
let cookie = '';
async function request(path, options = {}) {
  const res = await handler(new Request('http://localhost' + path, { ...options, headers: { Cookie: cookie, Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin', ...options.headers } }));
  return new Response(await res.arrayBuffer(), { status: res.status, headers: res.headers });
}
for (const path of ['/kindle', '/kindle/connect', '/kindle/transfer']) assert.equal((await request(path)).status, 303);
const serverDir = ${JSON.stringify(resolve("dist/server"))};
const manifest = (await Promise.all((await readdir(serverDir)).filter(n => n.includes('server-fn-resolver')).map(n => readFile(join(serverDir, n), 'utf8')))).join(' ');
const ids = new Map([...manifest.matchAll(/"([a-f0-9]{64})":\\s*\\{\\s*functionName: "(\\w+)_createServerFn_handler"/g)].map(m => [m[2], m[1]]));
async function rpc(name, data, method = 'GET') {
  assert.ok(ids.has(name), 'RPC emitted: ' + name);
  const args = encodeURIComponent(JSON.stringify([{ data, method, context: {} }]));
  return request('/_serverFn/data/' + ids.get(name) + '?args=' + args, { method });
}
const settings = { marginX: null, marginY: null, lineHeight: null, paragraphSpacing: null, textIndent: null, justify: null, fontFamily: null, customCss: '' };
const profile = { deviceId: 'device-a', name: '宽边距', settings };
for (const [name, data, method] of [['listKindleProfiles', 'device-a', 'GET'], ['createKindleProfile', profile, 'POST'], ['updateKindleProfile', { ...profile, id: 'x' }, 'POST'], ['deleteKindleProfile', { deviceId: 'device-a', id: 'x' }, 'POST']]) assert.equal((await rpc(name, data, method)).status, 303, 'protected ' + name);
const login = await request('/login', { method: 'POST', body: new URLSearchParams({ password: 'kindle-ui-password' }) });
assert.equal(login.status, 303); cookie = login.headers.getSetCookie()[0].split(';', 1)[0];
for (const path of ['/kindle', '/kindle/connect', '/kindle/transfer']) {
  const response = await request(path); assert.equal(response.status, 200, path); assert.equal(response.headers.get('cache-control'), 'no-store');
  const html = await response.text(); assert.match(html, /检测中…/); assert.doesNotMatch(html, /此页面正在实现|服务器内部错误/);
  if (path === '/kindle') { assert.match(html, new RegExp('<h2[^>]*>书籍</h2>')); assert.match(html, /kindle-book-table/); assert.match(html, /btn-quiet-danger/); }
  if (path.endsWith('connect')) { assert.match(html, /kindle-connect-page/); assert.match(html, new RegExp('<h1[^>]*>连接你的 Kindle</h1>')); assert.doesNotMatch(html, /data-kindle-device-bar|aria-label="Kindle 管理"/); }
  if (path.endsWith('transfer')) { assert.match(html, /GNU GENERAL PUBLIC LICENSE/); assert.match(html, /crates.io\\/api\\/v1\\/crates\\/boko\\/0.5.0\\/download/); }
}
async function result(name, data, method = 'GET') { const response = await rpc(name, data, method); assert.equal(response.status, 200, name); return (await response.json()).result; }
assert.equal((await result('listKindleProfiles', 'device-a')).length, 1);
const created = await result('createKindleProfile', profile, 'POST'); assert.equal(created.name, '宽边距'); assert.ok(created.id);
const updated = await result('updateKindleProfile', { ...profile, id: created.id, name: '更新后的方案', settings: { ...settings, marginX: 2 } }, 'POST'); assert.equal(updated.name, '更新后的方案'); assert.equal(updated.settings.marginX, 2);
assert.equal((await result('listKindleProfiles', 'device-b')).length, 1);
assert.equal((await result('listKindleProfiles', 'device-a')).length, 2);
await result('deleteKindleProfile', { deviceId: 'device-a', id: created.id }, 'POST');
assert.equal((await result('listKindleProfiles', 'device-a')).length, 1);
await writeFile(join(root, 'result.txt'), 'Kindle production checks passed');
} finally { await handler.shutdown(); }
`;
  try {
    const filename = join(directory, "check.mjs"); await writeFile(filename, code);
    const result = await promisify(execFile)(process.execPath, [filename], { timeout: 20000, maxBuffer: 1_000_000 });
    expect(await readFile(join(directory, "result.txt"), "utf8"), result.stderr).toBe("Kindle production checks passed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
