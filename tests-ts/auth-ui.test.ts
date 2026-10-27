import { beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { resolve } from "node:path";
import { allByRole, byName, byRole, formFor, parseHtml } from "./support/queries";
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
