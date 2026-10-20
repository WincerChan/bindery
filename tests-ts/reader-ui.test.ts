import { beforeAll, describe, expect, it, vi } from "vitest";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { solidOptions } from "../scripts/solid-options";
import { resolve } from "node:path";
import { contentUrl, defaultSettings, highlightedParts, initialPosition, normalizeSettings, pageMetrics, readerReturnTo, sectionUrl, textMatches, type ReaderData } from "../src/features/reader/model";
import { ProgressWriter } from "../src/features/reader/progress";
let ui: typeof import("./fixtures/reader/ui");
beforeAll(async () => {
  const result = await build({ configFile: false, logLevel: "silent", plugins: [solid(solidOptions)], ssr: { noExternal: true }, build: { write: false, minify: false, ssr: resolve("tests-ts/fixtures/reader/ui.tsx") } });
  const entry = (Array.isArray(result) ? result : [result]).flatMap(output => "output" in output ? output.output : []).find(output => output.type === "chunk" && output.isEntry);
  if (!entry || entry.type !== "chunk") throw new Error("Missing reader SSR bundle");
  ui = await import(/* @vite-ignore */ "data:text/javascript;base64," + Buffer.from(entry.code).toString("base64"));
});
describe("reader SSR and controls (adapted from test_reader_ui.py)", () => {
  it("renders three sandboxed frames, icon controls, native TOC links and escaped book copy", () => {
    const html = ui.renderReader();
    expect(html.match(/<iframe/g)).toHaveLength(3); expect(html.match(/sandbox="allow-same-origin"/g)).toHaveLength(3); expect(html).not.toContain("allow-scripts"); expect(html).not.toContain("srcdoc");
    for (const label of ["切换目录", "全文检索", "设置", "上一页", "下一页", "返回详情"]) expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain("书名&lt;&amp;>"); expect(html).toContain("第一章&lt;&amp;>"); expect(html).toContain("%E7%AC%AC%E4%B8%80%E7%AB%A0.xhtml");
    expect(html).toContain("return_to=%2Fjobs%3Ftab%3Dsuccess"); expect(html).toContain('aria-label="章节目录"'); expect(html).toContain('data-current-toc="true"');
    expect(html).toContain('href="/book/' + "d".repeat(32) + '?return_to='); expect(html).toContain('role="status"');
    expect(html).not.toMatch(/<h1|reader-footer|reader-chapter-nav|>上一页<|>下一页</);
    expect(html).toContain('aria-expanded="false"'); expect(html).toContain('aria-hidden="true"');
  });
  it("provides closed drawer/popovers, background segments and no custom controls before mount", () => {
    const html = ui.renderReader();
    expect(html.match(/<dialog/g)).toHaveLength(3); expect(html).toContain("aria-labelledby="); expect(html).toContain('type="submit"'); expect(html).toContain('type="search"');
    for (const copy of ["背景", "书籍", "灰白", "纸张", "砂岩", "薄荷", "样式", "自定义", "亮色", "暗色", "关键词", "书籍：尽量保持 EPUB 原样式；自定义：覆盖字体/字号/行高。"]) expect(html).toContain(copy);
    expect(html).not.toMatch(/<dialog[^>]*\sopen(?:[\s>])|<select|type="number"/);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('src="/book/d/cover?v=1"'); expect(html).not.toMatch(/<main|shadow|class="card/);
  });
  it("reports chapter page percentage, including the SSR resume seed", () => {
    const plain = (query = "") => ui.renderReader(query).replace(/<!--.*?-->/g, "");
    expect(plain()).toContain("1 / 1 · 100%");
    expect(plain()).toContain("共 2 节 · 当前 1");
    expect(plain("resume=1")).toContain("3 / 8 · 38%");
    expect(plain("resume=1")).toContain("共 2 节 · 当前 2");
  });
  it("restores the saved section only for resume=1; direct chapter links keep the requested chapter", () => {
    expect(ui.renderReader("resume=1")).toContain("Text/ch2.xhtml");
    expect(ui.renderReader("resume=0")).toContain("%E7%AC%AC%E4%B8%80%E7%AB%A0.xhtml");
  });
});
describe("reader pagination, resume and settings", () => {
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
