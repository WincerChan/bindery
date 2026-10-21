import { beforeAll, describe, expect, it, vi } from "vitest";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { resolve } from "node:path";
import { navigation, navActive, settings } from "../src/shell/navigation";
import { flashFromUrl, toastMessage, withToast } from "../src/shared/notifications";
import { installToastBridge } from "../src/client/toast";

let ui: typeof import("./support/ui-probe");
beforeAll(async () => {
  const result = await build({
    configFile: false, logLevel: "silent", plugins: [solid({ ssr: true })],
    ssr: { noExternal: true },
    build: { write: false, minify: false, ssr: resolve("tests-ts/support/ui-probe.tsx") },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const entry = outputs.flatMap(o => "output" in o ? o.output : []).find(o => o.type === "chunk" && o.isEntry);
  if (!entry || entry.type !== "chunk") throw new Error("Missing UI SSR test bundle");
  ui = await import(/* @vite-ignore */ "data:text/javascript;base64," + Buffer.from(entry.code).toString("base64"));
});

describe("reusable UI SSR", () => {
  it("renders real controls with labels, variants, help/error relationships and toggle states", () => {
    const html = ui.controls();
    for (const variant of ["primary", "secondary", "quiet", "danger"]) expect(html).toContain(`btn-${variant}`);
    expect(html).toMatch(/type="button"/); expect(html).toMatch(/type="submit"/); expect(html).toContain("btn-sm");
    expect(html).toContain("disabled");
    expect(html).toMatch(/<label[^>]*for="[^"]+"[^>]*><span>书名<\/span>/);
    expect(html).toMatch(/name="title"[^>]*required/);
    expect(html).toContain('aria-invalid="true"'); expect(html).toContain('aria-describedby="external-help author-help"');
    expect(html).toContain('id="author-help"'); expect(html).toContain("作者不能为空");
    expect(html).toContain('<select'); expect(html).toContain('<textarea');
    expect(html).toContain('type="checkbox"'); expect(html).toContain("已读");
    expect(html).toContain('aria-checked="mixed"');
    expect(html).toContain('aria-pressed="true"'); expect(html).toContain('aria-pressed="false"');
    expect(html).not.toMatch(/<button[^>]*\sselected=/);
    expect(html).toContain("tag-failed");
  });
  it("ports five cover tones and grid/list text with escaped content", () => {
    expect(["00", "01", "02", "03", "04", "ff", "invalid"].map(ui.coverTone)).toEqual([0, 1, 2, 3, 4, 0, 0]);
    const html = ui.covers();
    expect(html).toContain("春日&lt;&amp;>"); expect(html).toContain("cover-gen-author");
    expect(html).toContain("cover-compact"); expect(html).toContain("🌿");
    expect(html).toContain('role="img"'); expect(html).toContain('alt="有封面"');
    expect(html).toContain('loading="lazy"'); expect(html).toContain("cover-tone-2");
  });
  it("provides opt-in underline filters, quiet danger and icon buttons, and a hidden search label", () => {
    const html = ui.kindleControls();
    expect(html).toContain("btn-quiet-danger"); expect(html).toContain("btn-icon");
    expect(html).toContain('aria-label="预览书籍"'); expect(html).toContain('aria-hidden="true"');
    expect(html).toMatch(/class="text-filter is-selected [^"]*" aria-pressed="true"/);
    expect(html).toContain('aria-pressed="false"'); expect(html).toContain('class="sr-only">搜索设备上的书</span>');
    expect(html).not.toMatch(/\s(?:variant|selected|labelHidden)=/);
  });
  it("uses native dialogs with labelled titles and explicit confirm/cancel controls", () => {
    const html = ui.dialogs();
    expect(html.match(/<dialog/g)).toHaveLength(2);
    expect(html).toContain("aria-labelledby="); expect(html).toContain("关闭对话框");
    expect(html).toContain("确定删除？"); expect(html).toContain("取消"); expect(html).toContain("确认");
    expect(html).not.toMatch(/<dialog[^>]*\sopen(?:\s|>)/);
  });
  it("provides flat empty states and accessible pagination preserving search/view/hash", () => {
    expect(ui.empty()).toContain("暂无内容"); expect(ui.empty()).toContain("还没有书籍。"); expect(ui.empty()).toContain('href="/ingest"');
    expect(ui.pagination(1, 1)).not.toContain('aria-label="分页"');
    expect(ui.pagination(1, 100)).toContain('aria-disabled="true"');
    expect(ui.pagination(5, 100)).toContain('aria-current="page"');
    expect(ui.paginationItems(5, 10)).toEqual([1, "gap", 4, 5, 6, "gap", 10]);
    expect(ui.paginationItems(99, 3)).toEqual([1, 2, 3]);
    expect(ui.pageHref("/?q=书&view=list#books", 3)).toBe("/?q=%E4%B9%A6&view=list&page=3#books");
  });
});

describe("navigation and global flash messages", () => {
  it("uses four primary entries, separate settings, book prefix and wishlist/theme aliases", () => {
    expect(navigation.map(n => n.label)).toEqual(["书库", "入库", "追踪", "设备"]);
    for (const path of ["/", "/book/abc", "/book/abc/preview", "/books/download"]) expect(navActive(path, "/")).toBe(true);
    for (const path of ["/tracker", "/wishlist", "/wishlist/export"]) expect(navActive(path, "/tracker")).toBe(true);
    expect(navActive("/archive", "/")).toBe(false);
    expect(settings.map(item => item.label)).toEqual(["规则与主题", "安全与通行密钥"]);
    for (const path of ["/rules", "/rules/x/editor", "/themes/x/editor"]) expect(navActive(path, "/rules")).toBe(true);
    for (const path of ["/devices", "/devices/connect", "/devices/fonts"]) expect(navActive(path, "/devices")).toBe(true);
    expect(navActive("/security", "/security")).toBe(true); expect(navActive("/ingest", "/rules")).toBe(false);
  });
  it("normalizes toast kinds and consumes query flashes while preserving other state", () => {
    expect(toastMessage("  ")).toBeNull(); expect(toastMessage("完成", " WARN ")).toEqual({ message: "完成", kind: "success" });
    const url = withToast("/ingest?q=甲&q=乙#upload", "创建成功", "warning");
    expect(flashFromUrl(url)).toEqual({ toast: { message: "创建成功", kind: "warning" }, cleanUrl: "/ingest?q=%E7%94%B2&q=%E4%B9%99#upload" });
    expect(flashFromUrl(withToast("/ingest?jobs_tab=running#jobs", "已创建 2 个任务")).toast?.message).toBe("已创建 2 个任务");
    expect(flashFromUrl(withToast("/ingest?jobs_tab=running#jobs", "已创建 2 个任务")).cleanUrl).toBe("/ingest?jobs_tab=running#jobs");
    expect(withToast("//evil.test", "完成")).toMatch(/^\/\?toast=/);
    expect(flashFromUrl("/ingest?toast_kind=error").toast).toBeNull();
  });
  it("accepts direct and HTMX-enveloped events and cleans up listeners", () => {
    const body = new EventTarget(), receive = vi.fn();
    const target = { document: { body } } as unknown as Window;
    const cleanup = installToastBridge(target, receive);
    const emit = (detail: unknown) => body.dispatchEvent(new CustomEvent("bindery:toast", { detail }));
    emit({ message: "保存成功", kind: "success" }); emit({ value: { message: "失败", kind: "ERROR" } }); emit({ value: { message: "" } });
    expect(receive.mock.calls.map(c => c[0])).toEqual([{ message: "保存成功", kind: "success" }, { message: "失败", kind: "error" }]);
    expect(target.binderyToast).toBeTypeOf("function"); cleanup(); emit({ message: "已解绑" });
    expect(receive).toHaveBeenCalledTimes(2); expect(target.binderyToast).toBeUndefined();
  });
});
