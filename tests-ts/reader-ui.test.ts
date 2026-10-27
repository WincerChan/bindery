import { beforeAll, describe, expect, it, vi } from "vitest";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { solidOptions } from "../scripts/solid-options";
import { resolve } from "node:path";
import { contentUrl, defaultSettings, fractionPage, highlightedParts, initialPosition, normalizeSettings, pageMetrics, readerReturnTo, sectionUrl, textMatches, type ReaderData } from "../src/features/reader/model";
import { ProgressWriter } from "../src/features/reader/progress";
import { readerInitialSettings, readerPaper, readerPercent, readerProgressTarget, resumeFraction } from "../src/features/reader/reader-presentation";
import { allByAttribute, allByRole, byAttribute, byLabel, byRole, parseHtml } from "./support/queries";
let ui: typeof import("./fixtures/reader/ui");
beforeAll(async () => {
  const result = await build({ configFile: false, logLevel: "silent", plugins: [solid(solidOptions)], ssr: { noExternal: true }, build: { write: false, minify: false, ssr: resolve("tests-ts/fixtures/reader/ui.tsx") } });
  const entry = (Array.isArray(result) ? result : [result]).flatMap(output => "output" in output ? output.output : []).find(output => output.type === "chunk" && output.isEntry);
  if (!entry || entry.type !== "chunk") throw new Error("Missing reader SSR bundle");
  ui = await import(/* @vite-ignore */ "data:text/javascript;base64," + Buffer.from(entry.code).toString("base64"));
});
describe("reader SSR and controls (adapted from test_reader_ui.py)", () => {
  it("renders three sandboxed frames, icon controls, native TOC links and escaped book copy", () => {
    const root = parseHtml(ui.renderReader()), frames = Array.from(root.getElementsByTagName("iframe"));
    expect(frames).toHaveLength(3);
    for (const frame of frames) { expect(frame.getAttribute("sandbox")).toBe("allow-same-origin"); expect(frame.hasAttribute("srcdoc")).toBe(false); }
    for (const name of ["目录与检索", "阅读设置", "上一页", "下一页", "上一章", "下一章"]) expect(byRole(root, "button", name)).toBeDefined();
    for (const name of ["目录与检索", "阅读设置"]) expect(byRole(root, "button", name).getAttribute("aria-expanded")).toBe("false");
    expect(root.textContent).toContain("书名<&>"); expect(root.textContent).toContain("第一章<&>");
    expect(byAttribute(root, "title", "阅读正文").getAttribute("src")).toContain("%E7%AC%AC%E4%B8%80%E7%AB%A0.xhtml");
    expect(byRole(root, "link", "书名<&>").getAttribute("href")).toBe(`/book/${"d".repeat(32)}?return_to=%2Fjobs%3Ftab%3Dsuccess`);
    const toc = byRole(root, "navigation", "章节目录");
    expect(byAttribute(toc, "aria-current", "page").textContent).toContain("第一章<&>");
    expect(byAttribute(toc, "aria-current", "page").textContent).toContain("正在读");
    expect(allByRole(root, "status").length).toBeGreaterThan(0);
    expect(frames.filter(frame => frame.getAttribute("aria-hidden") === "true")).toHaveLength(2);
  });
  it("provides one modal contents/search sheet and nonmodal Aa with named v2 controls", () => {
    const root = parseHtml(ui.renderReader());
    expect(allByRole(root, "dialog")).toHaveLength(2);
    for (const name of ["目录与检索", "排版"]) expect(byRole(root, "dialog", name).hasAttribute("open")).toBe(false);
    expect(byRole(root, "dialog", "目录与检索").getAttribute("aria-modal")).toBe("true");
    expect(byRole(root, "dialog", "排版").hasAttribute("aria-modal")).toBe(false);
    expect(byRole(root, "button", "开始检索").getAttribute("type")).toBe("submit"); expect(byLabel(root, "在全书中检索").getAttribute("type")).toBe("search");
    for (const name of ["书籍原样", "自定义", "衬线", "无衬线", "等宽", "米白", "纯白", "暗色", "两端对齐", "左对齐", "增大字号", "减小字号"]) expect(byRole(root, "button", name)).toBeDefined();
    for (const name of ["行高", "左右边距", "上下边距", "全书进度（按章节估算）"]) expect(byRole(root, "slider", name)).toBeDefined();
    expect(allByRole(root, "combobox")).toHaveLength(0); expect(allByRole(root, "spinbutton")).toHaveLength(0);
    expect(allByAttribute(root, "aria-pressed", "true").length).toBeGreaterThan(0);
    expect(allByRole(root, "main")).toHaveLength(0);
  });
  it("reports chapter viewport pages and estimated global percentage, including the SSR resume seed", () => {
    const plain = (query = "") => parseHtml(ui.renderReader(query)).textContent;
    expect(plain()).toContain("1 / 1 跨页 · 50%");
    expect(plain()).toContain("共 2 节 · 当前 1");
    expect(plain("resume=1")).toContain("3 / 8 跨页 · 64%");
    expect(plain("resume=1")).toContain("共 2 节 · 当前 2");
  });
  it("restores the saved section only for resume=1; direct chapter links keep the requested chapter", () => {
    expect(byAttribute(parseHtml(ui.renderReader("resume=1")), "title", "阅读正文").getAttribute("src")).toContain("Text/ch2.xhtml");
    expect(byAttribute(parseHtml(ui.renderReader("resume=0")), "title", "阅读正文").getAttribute("src")).toContain("%E7%AC%AC%E4%B8%80%E7%AB%A0.xhtml");
  });
});
describe("reader pagination, resume and settings", () => {
  it("uses responsive first-use typography without changing saved-setting normalization", () => {
    expect(readerInitialSettings()).toMatchObject({ styleMode: "custom", fontSize: 21, lineHeight: 2.1, readerBg: "paper" });
    expect(readerInitialSettings(true)).toMatchObject({ fontSize: 19, lineHeight: 2, pagePaddingX: 24 });
    expect(normalizeSettings(defaultSettings)).toEqual(defaultSettings);
    expect(readerPaper({ ...defaultSettings, readerBg: "mint" })).toBe("paper");
    expect(readerPaper({ ...defaultSettings, brightnessMode: "dim" })).toBe("dark");
  });
  it("estimates whole-book progress by chapters and resolves scrub endpoints safely", () => {
    expect(readerPercent(0, 1, 3, 2)).toBe(0);
    expect(readerPercent(1, 3, 3, 2)).toBe(100);
    expect(readerProgressTarget(75, 2)).toEqual({ section: 1, fraction: .5 });
    expect(readerProgressTarget(100, 2)).toEqual({ section: 1, fraction: 1 });
    expect(readerProgressTarget(-10, 2)).toEqual({ section: 0, fraction: 0 });
  });
  it("resumes saved pages by position within the section, not by page number, across layout changes", () => {
    // Saved halfway through an 81-page single-column chapter; the spread layout now has 41 pages.
    const fraction = resumeFraction(41, 81);
    expect(fraction).toBe(.5); expect(fractionPage(fraction!, 41)).toBe(21);
    expect(resumeFraction(3, 8, .9)).toBe(.9); // an explicit device fraction wins
    expect(resumeFraction(1, 1)).toBeUndefined(); expect(resumeFraction(99, 8)).toBe(1);
  });
  it.each([[390, 390, 0, 1, 1], [390, 780, 0, 2, 1], [390, 1170, 780, 3, 3], [390, 780.4, 390, 2, 2], [390, 780.6, 390, 3, 2], [0, 0, 0, 1, 1]])("computes float-safe metrics for %j", (width, total, left, count, page) => {
    expect(pageMetrics(width, total, left)).toMatchObject({ count, page });
  });
  it("preserves safe return queries, removes fragments and percent-encodes EPUB segments", () => {
    expect(readerReturnTo(" /jobs?tab=success#x ")).toBe("/jobs?tab=success"); expect(readerReturnTo("//evil.test", "")).toBe("");
    expect(sectionUrl("id", 3, "/?q=书", { page: "last" })).toBe("/book/id/preview/3?return_to=%2F%3Fq%3D%E4%B9%A6&page=last");
    expect(contentUrl("id", "Text/章 1.xhtml")).toBe("/book/id/epub/Text/%E7%AB%A0%201.xhtml");
  });
  it("validates resume positions, last-page navigation and default page one", () => {
    const data = { section_index: 0, sections: [{}, {}], initial_progress: { section: 1, page: 3 } } as ReaderData;
    expect(initialPosition(data, new URLSearchParams("resume=1"))).toEqual({ section: 1, page: 3 });
    expect(initialPosition(data, new URLSearchParams("resume=0"))).toEqual({ section: 0, page: 1 });
    expect(initialPosition(data, new URLSearchParams("resume=1&nav=prev"))).toEqual({ section: 1, page: 1 });
    expect(initialPosition(data, new URLSearchParams("page=last"))).toEqual({ section: 0, page: Number.MAX_SAFE_INTEGER });
    data.initial_progress!.section = -1; expect(initialPosition(data, new URLSearchParams("resume=1"))).toEqual({ section: 0, page: 1 });
  });
  it("prefers the newest source, falls back when a device has no section, and converts fractions to pages", () => {
    const base = { section_index: 0, sections: [{}, {}, {}], initial_progress: { section: 1, page: 3, page_count: 8 } } as ReaderData;
    const web = { source: "web", section: 1, section_fraction: 0.25, page: 3, page_count: 8, read_at: "2026-10-22T13:00:00Z" };
    const device = { source: { device_id: "kobo-1", device_name: "Libra 2", kind: "kobo" }, section: 2, section_fraction: 0.5, percent: 70, read_at: "2026-10-22T13:11:20Z" };
    expect(initialPosition({ ...base, latest_progress: web } as ReaderData, new URLSearchParams("resume=1"))).toEqual({ section: 1, page: 3 });
    expect(initialPosition({ ...base, latest_progress: device } as ReaderData, new URLSearchParams("resume=1"))).toEqual({ section: 2, page: 1, fraction: 0.5 });
    expect(initialPosition({ ...base, latest_progress: { ...device, section: null } } as ReaderData, new URLSearchParams("resume=1"))).toEqual({ section: 1, page: 3 });
    expect(initialPosition({ ...base, initial_progress: null, latest_progress: { ...device, section: null } } as ReaderData, new URLSearchParams("resume=1"))).toEqual({ section: 0, page: 1 });
    expect(initialPosition({ ...base, latest_progress: device } as ReaderData, new URLSearchParams("resume=1&nav=prev"))).toEqual({ section: 2, page: 1 });
    expect(fractionPage(0, 10)).toBe(1); expect(fractionPage(0.5, 10)).toBe(6); expect(fractionPage(1, 10)).toBe(10); expect(fractionPage(0.5, 1)).toBe(1);
  });
  it("normalizes persisted settings and supports legacy line-height without CSS injection", () => {
    expect(normalizeSettings(null)).toEqual(defaultSettings);
    expect(normalizeSettings({ styleMode: "custom", fontFamily: "bad; color:red", fontSize: 900, lineHeight: 0.85, pagePaddingX: -100, brightnessMode: "dim", textAlignMode: "left" })).toMatchObject({ styleMode: "custom", fontFamily: "serif", fontSize: 28, lineHeight: 1.85, pagePaddingX: -1, brightnessMode: "dim", textAlignMode: "left" });
  });
  it("highlights literal matches safely with Unicode lower-case expansion and astral offsets", () => {
    expect(textMatches("İ βETA 😀 BETA", "beta")).toEqual([{ start: 10, end: 14 }]);
    expect(textMatches("İ BETA", "beta")).toEqual([{ start: 2, end: 6 }]);
    expect(highlightedParts("<script> BETA beta", "beta")).toEqual([{ text: "<script> ", matched: false }, { text: "BETA", matched: true }, { text: " ", matched: false }, { text: "beta", matched: true }]);
  });
});
describe("serialized progress persistence", () => {
  it("calls the default global fetch without a ProgressWriter receiver", async () => {
    const transport = vi.fn(function (this: unknown, _url: RequestInfo | URL, _init?: RequestInit) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(Response.json({ ok: true }));
    });
    vi.stubGlobal("fetch", transport);
    const report = vi.fn(), writer = new ProgressWriter("id", report);
    try {
      writer.queue(1, 3, 8); await writer.flush();
      expect(transport).toHaveBeenCalledExactlyOnceWith("/book/id/progress", expect.objectContaining({
        method: "POST", credentials: "same-origin", keepalive: true,
        body: '{"section":1,"page":3,"page_count":8}',
      }));
      expect(report).toHaveBeenLastCalledWith("");
    } finally { writer.destroy(); vi.unstubAllGlobals(); }
  });
  it("serializes concurrent page writes and posts the newest queued position", async () => {
    const requests: { body: unknown; complete: (value: Response) => void }[] = [];
    const transport = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>(complete => requests.push({ body: JSON.parse(String(init!.body)), complete }))), report = vi.fn();
    const writer = new ProgressWriter("id", report, transport);
    writer.queue(0, 1, 8); const first = writer.flush(); writer.queue(0, 2, 8); writer.queue(1, 1, 5); await writer.flush();
    expect(requests).toHaveLength(1); requests[0].complete(Response.json({ ok: true })); await first;
    expect(requests).toHaveLength(2); expect(requests[1].body).toEqual({ section: 1, page: 1, page_count: 5 }); requests[1].complete(Response.json({ ok: true }));
    writer.destroy();
  });
  it("retains failed writes for a later retry and reports the actual failure", async () => {
    const report = vi.fn(), transport = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(Response.json({ ok: true }));
    const writer = new ProgressWriter("id", report, transport); writer.queue(0, 3, 8); await writer.flush();
    expect(report).toHaveBeenLastCalledWith("阅读进度保存失败，将在下次翻页时重试");
    await writer.flush(); expect(transport).toHaveBeenCalledTimes(2); expect(report).toHaveBeenLastCalledWith(""); writer.destroy();
  });
  it("flushes an application/json beacon on page hide with a fetch fallback", async () => {
    const transport = vi.fn().mockResolvedValue(Response.json({ ok: true })), beacon = vi.fn((_url: string, _data: Blob) => true);
    const writer = new ProgressWriter("id", () => {}, transport); writer.queue(2, 5, 12); writer.unload(beacon);
    expect(beacon).toHaveBeenCalledTimes(1); expect(await beacon.mock.calls[0][1].text()).toBe('{"section":2,"page":5,"page_count":12}'); expect(beacon.mock.calls[0][1].type).toBe("application/json");
    await writer.flush(); expect(transport).not.toHaveBeenCalled(); writer.destroy();
  });
});
