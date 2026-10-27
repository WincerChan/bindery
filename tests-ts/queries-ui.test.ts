import { describe, expect, it } from "vitest";
import { accessibleName, allByRole, byAttribute, byLabel, byName, byRole, byText, formFor, parseHtml } from "./support/queries";

describe("semantic queries in the existing SSR DOM harness", () => {
  it("decodes HTML and scopes detached, nested and associated labels independently of wrappers", () => {
    const root = parseHtml('<label for="title"><span>书名</span></label><div><input id="title" name="title" value="A&lt;&amp;&gt;"></div><label><span>方案</span><div><select name="profile"><option>默认</option></select></div></label>');
    expect(byLabel(root, "书名")).toBe(byName(root, "title")); expect(byLabel(root, "书名").getAttribute("value")).toBe("A<&>");
    expect(byRole(root, "combobox", "方案")).toBe(byLabel(root, "方案"));
    // An option doesn't inherit the surrounding select's label.
    expect(byRole(byName(root, "profile"), "option", "默认")).toBeDefined();
  });
  it("follows ARIA name references and ignores decorative icons when naming actions", () => {
    const root = parseHtml('<h2 id="title"> 删除 书籍 </h2><dialog aria-labelledby="title"><div><button aria-label="关闭">×</button></div><button><span aria-hidden="true">✓</span><span>确认</span></button></dialog><section aria-labelledby="title"></section>');
    const dialog = byRole(root, "dialog", "删除 书籍");
    expect(accessibleName(byRole(dialog, "button", "关闭"))).toBe("关闭");
    expect(byRole(dialog, "button", "确认")).toBeDefined(); expect(byRole(root, "region", "删除 书籍")).toBeDefined();
  });
  it("rejects missing and ambiguous matches rather than silently choosing a control", () => {
    const root = parseHtml('<form action="/first"><button>保存</button></form><form action="/second"><button>保存</button></form>');
    expect(() => byRole(root, "button", "取消")).toThrow("found 0"); expect(() => byRole(root, "button", "保存")).toThrow("found 2");
    expect(byRole(byAttribute(root, "action", "/second"), "button", "保存")).toBeDefined();
    expect(allByRole(root, "button", /保存/g)).toHaveLength(2);
  });
  it("finds text and the owning form through changed wrappers, including closed SSR dialogs", () => {
    const root = parseHtml('<dialog><form action="/delete"><section><div><button><span>永久</span>删除</button><p> 不可<!-- SSR --> 撤销 </p></div></section></form></dialog>');
    const action = byRole(root, "button", "永久删除");
    expect(formFor(action).getAttribute("action")).toBe("/delete"); expect(byText(root, "不可 撤销").textContent).toContain("撤销");
    expect(() => formFor(byRole(root, "dialog"))).toThrow("no containing form");
  });
});
