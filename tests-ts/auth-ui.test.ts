import { beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import { binderyIcons } from "../scripts/vite-icons";
import solid from "vite-plugin-solid";
import { resolve } from "node:path";
import { allByRole, byAttribute, byName, byRole, formFor, parseHtml } from "./support/queries";
let ui: typeof import("./fixtures/auth/ui-probe");
beforeAll(async () => {
  const result = await build({
    configFile: false, logLevel: "silent", plugins: [...binderyIcons(), solid({ ssr: true })],
    ssr: { noExternal: true }, build: { write: false, minify: false, ssr: resolve("tests-ts/fixtures/auth/ui-probe.tsx") },
  });
  const entry = (Array.isArray(result) ? result : [result]).flatMap(output => "output" in output ? output.output : []).find(output => output.type === "chunk" && output.isEntry);
  if (!entry || entry.type !== "chunk") throw new Error("Missing login UI SSR bundle");
  ui = await import(/* @vite-ignore */ "data:text/javascript;base64," + Buffer.from(entry.code).toString("base64"));
});
describe("security settings SSR", () => {
  it("provides settings navigation, passkey metadata and protected management forms", () => {
    const root = parseHtml(ui.security({ passkey_configured: true, toast: null, passkeys: [
      { credential_id: "synced", name: "我的电脑", device_type: "multi_device", backed_up: 1, created_at: "2025-10-01T00:00:00Z", last_used_at: "2025-10-20T00:00:00Z" },
      { credential_id: "local", name: "备用密钥", device_type: "single_device", backed_up: 0, created_at: "2025-09-01T00:00:00Z", last_used_at: null },
    ] }));
    expect(byRole(root, "link", "设置").getAttribute("href")).toBe("/settings");
    expect(byRole(root, "heading", "安全")).toBeDefined();
    expect(byRole(root, "heading", "我的电脑")).toBeDefined();
    expect(root.textContent).toContain("已同步 · 10-01 添加 · 10-20 用过");
    expect(root.textContent).toContain("仅此设备 · 09-01 添加 · 尚未用过");
    expect(allByRole(root, "button", "重命名")).toHaveLength(2);
    expect(byAttribute(root, "action", "/security/passkeys/local/delete").getAttribute("method")).toBe("post");
    expect(byRole(root, "button", "删除通行密钥 备用密钥")).toBeDefined();
    expect(byRole(root, "button", "添加通行密钥")).toBeDefined();
    expect(root.textContent).toContain("BINDERY_PASSWORD_HASH");
  });
  it("keeps empty and unavailable states explicit without offering unsupported enrollment", () => {
    const root = parseHtml(ui.security({ passkey_configured: false, toast: null, passkeys: [] }));
    expect(root.textContent).toContain("还没有通行密钥");
    expect(root.textContent).toContain("BINDERY_PUBLIC_ORIGIN");
    expect(byRole(root, "button", "添加通行密钥").hasAttribute("disabled")).toBe(true);
  });
});
describe("passkey-first login SSR", () => {
  it("offers passkey login first and a password disclosure for progressive enhancement", () => {
    const html = ui.login(true), root = parseHtml(html);
    const actions = allByRole(root, "button");
    expect(actions.indexOf(byRole(root, "button", "使用通行密钥登录"))).toBeLessThan(actions.indexOf(byRole(root, "button", "使用密码登录")));
    const password = byName(root, "password"), form = formFor(password);
    expect(password.getAttribute("autocomplete")).toBe("current-password webauthn");
    expect(byName(form, "next").getAttribute("value")).toBe("/?q=a:b");
    expect(form.getAttribute("action")).toBe("/login");
    expect(root.textContent).toContain("登录你的私人书库");
    expect(root.textContent).not.toContain("PRIVATE LIBRARY");
  });
  it("keeps the password form primary when no passkey is available", () => {
    const root = parseHtml(ui.login(false)), password = byName(root, "password");
    expect(allByRole(root, "button", "使用通行密钥登录")).toHaveLength(0);
    expect(allByRole(root, "button", "使用密码登录")).toHaveLength(0);
    expect(formFor(password).getAttribute("action")).toBe("/login");
    expect(password.getAttribute("autocomplete")).toBe("current-password");
    expect(root.textContent).toContain("登录你的私人书库");
  });
  it("shows configuration and password errors without hiding the no-JavaScript form", () => {
    const root = parseHtml(ui.loginWithoutPasswordHash());
    expect(root.textContent).toContain("未配置 BINDERY_PASSWORD_HASH");
    expect(root.textContent).toContain("密码错误");
    const form = formFor(byName(root, "password"));
    expect(byRole(form, "button").hasAttribute("disabled")).toBe(true);
  });
});
