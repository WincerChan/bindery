import { beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { resolve } from "node:path";
let ui: typeof import("./fixtures/auth/ui-probe");
beforeAll(async () => {
  const result = await build({
    configFile: false, logLevel: "silent", plugins: [solid({ ssr: true })],
    ssr: { noExternal: true }, build: { write: false, minify: false, ssr: resolve("tests-ts/fixtures/auth/ui-probe.tsx") },
  });
  const entry = (Array.isArray(result) ? result : [result]).flatMap(output => "output" in output ? output.output : []).find(output => output.type === "chunk" && output.isEntry);
  if (!entry || entry.type !== "chunk") throw new Error("Missing login UI SSR bundle");
  ui = await import(/* @vite-ignore */ "data:text/javascript;base64," + Buffer.from(entry.code).toString("base64"));
});
describe("passkey-first login SSR", () => {
  it("puts a full-width passkey action first and keeps the password form behind progressive-enhancement details", () => {
    const html = ui.login(true);
    expect(html).toContain("使用通行密钥登录");
    expect(html).toMatch(/class="[^"]*btn-primary[^"]*login-passkey/);
    expect(html).toContain("<details");
    expect(html).toContain("使用密码登录");
    expect(html).toContain('action="/login"');
    expect(html).toContain('name="password"');
    expect(html).toContain('autocomplete="current-password webauthn"');
    expect(html).toContain('name="next" value="/?q=a:b"');
    expect(html).toContain('class="page-title"');
    expect(html).toContain("登录你的私人书库");
    expect(html).not.toContain("PRIVATE LIBRARY");
  });
  it("keeps the password form primary when no passkey is available", () => {
    const html = ui.login(false);
    expect(html).not.toContain("使用通行密钥登录");
    expect(html).not.toContain("<details");
    expect(html).toContain('action="/login"');
    expect(html).toContain('name="password"');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain("登录你的私人书库");
  });
  it("shows configuration and password errors without hiding the no-JavaScript form", () => {
    const html = ui.loginWithoutPasswordHash();
    expect(html).toContain("未配置 BINDERY_PASSWORD_HASH");
    expect(html).toContain("密码错误");
    expect(html).toContain('name="password"');
    expect(html).toMatch(/type="submit"[^>]*disabled/);
  });
});
