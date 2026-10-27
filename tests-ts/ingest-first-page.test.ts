import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { LibraryStorage } from "../src/server/storage";
import { BinderyDatabase } from "../src/server/db";
import { firstPagePreview, firstPageResponse, type FirstPageResult } from "../src/server/ingest/first-page";
import { cleanupStaged, loadStaged, stageUpload } from "../src/server/ingest/staging";
import { authenticatedRoute } from "../src/server/http";
import { signIn } from "../src/server/auth";
import { buildEpub, buildEpubFromSectionStream, updateEpubMetadata } from "../src/core/epub";
import { readArchive, writeArchive } from "../src/core/archive";
import { metadataFromDict } from "../src/core/models";
import { parseBook, parseBookEvents } from "../src/core/parsing";
import { composeBookCss } from "../src/server/epub-css";
import { getRule, templateDirectory } from "../src/server/templates";
import { isolatedBookHtml } from "../src/server/reader/resources";
import { ReaderArchive } from "../src/server/reader/archive";
import { ReadLimitError } from "../src/server/read-limits";
import { decodedFileLines, parseBookFileEvents } from "../src/server/parsing";
import { inlineCssImports } from "../src/core/css-strip";
import masterFixture from "./fixtures/ingest-first-page-master.json";

vi.mock("node:fs", async original => {
  const actual = await original<typeof fs>();
  return { ...actual, readSync: vi.fn(actual.readSync), closeSync: vi.fn(actual.closeSync) };
});

const root = fs.mkdtempSync(join(tmpdir(), "bindery-first-page-"));
let library: LibraryStorage, dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(join(root, "case-"));
  library = new LibraryStorage(join(dir, "library"), new BinderyDatabase(join(dir, "db.sqlite"))); library.ensure();
  vi.stubEnv("BINDERY_TEMPLATE_DIR", join(dir, "templates")); vi.stubEnv("BINDERY_RULES_DIR", ""); vi.stubEnv("BINDERY_THEMES_DIR", ""); vi.stubEnv("BINDERY_STAGE_DIR", join(dir, "stage"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const prose = "这是首章的正文。窗前花影摇曳，院中流水潺潺，读书的人静静坐着，翻开下一页。";
const txt = async (text: string) => stageUpload(library, new File([text], "sample.txt", { type: "text/plain" }));
const page = (token: string, rule = "default", theme = "default") => firstPagePreview(library, { upload_token: token, rule_id: rule, theme_id: theme });
function success(result: FirstPageResult) { expect(result).not.toHaveProperty("error"); if ("error" in result) throw new Error(result.error); return result; }
const parse = (html: string) => new DOMParser({ onError: () => {} }).parseFromString(html, "text/html");
function body(html: string) {
  return new XMLSerializer().serializeToString(parse(html).getElementsByTagName("body")[0]!);
}
const isolate = (bytes: Uint8Array) => isolatedBookHtml(bytes, "/", "https://preview.invalid/", undefined, true);
function theme() { fs.writeFileSync(join(templateDirectory("themes"), "z-blue.json"), JSON.stringify({ id: "blue", css: "body { color: #123abc; } .chapter-title { letter-spacing: .2em; }" })); }

interface Doc { name: string; body: string; properties?: string; linear?: string; head?: string }
function epub(docs: Doc[], styles: Record<string, string> = {}, extra: Array<{ name: string; data: Uint8Array }> = [], guide = "") {
  return writeArchive([
    { name: "mimetype", data: encode("application/epub+zip") },
    { name: "META-INF/container.xml", data: encode('<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>') },
    { name: "OPS/book.opf", data: encode(`<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>书名</dc:title></metadata><manifest>${docs.map((doc, i) => `<item id="d${i}" href="${doc.name}" media-type="application/xhtml+xml" properties="${doc.properties || ""}"/>`).join("")}${Object.keys(styles).map((name, i) => `<item id="css${i}" href="${name}" media-type="text/css"/>`).join("")}</manifest><spine>${docs.map((doc, i) => `<itemref idref="d${i}" linear="${doc.linear || "yes"}"/>`).join("")}</spine>${guide}</package>`) },
    ...docs.map(doc => ({ name: `OPS/${doc.name}`, data: encode(`<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${doc.name}</title>${doc.head || ""}</head><body>${doc.body}</body></html>`) })),
    ...Object.entries(styles).map(([name, text]) => ({ name: `OPS/${name}`, data: encode(text) })), ...extra,
  ], null);
}
const stageEpub = async (bytes: Uint8Array) => stageUpload(library, new File([new Uint8Array(bytes)], "book.epub", { type: "application/epub+zip" }));

it.each([
  { prefix: "卷一\n卷中说明\n", volume: "卷一" },
  { prefix: "卷一\n", volume: "卷一" },
  { prefix: "", volume: null },
])("uses both builders' exact chapter document without synthesized markup ($prefix)", async ({ prefix, volume }) => {
  const text = `书名：浮生\n简介：这是简介\n\n${prefix}第一章 空章\n第二章 闺房记乐\n${prose}\n第二段文字\n第三章 后续\n不应出现`;
  const staged = await txt(text), result = success(page(staged.token));
  expect(result.section_title).toBe("第二章 闺房记乐"); expect(result.volume_title).toBe(volume); expect(result.html).not.toContain("卷一"); expect(result.html).not.toContain("这是简介"); expect(result.html).not.toContain("不应出现");
  expect(result.html).toContain('class="chapter-stamp">第二章'); expect(result.html).toContain('class="chapter-title">闺房记乐');
  const meta = metadataFromDict({ title: "浮生", source_type: "txt", theme_template: "default" });
  const events = [...parseBookEvents(text, "sample", getRule("default")?.rules)];
  for (const built of [buildEpub(parseBook(text, "sample", getRule("default")?.rules), meta), buildEpubFromSectionStream({ stream_sections: events.filter(e => "kind" in e), source_intro: "这是简介", source_author: null, meta })]) {
    const chapter = readArchive(built).find(member => member.name.endsWith(".xhtml") && decode(member.data).includes(prose))!;
    expect(body(result.html)).toBe(body(isolate(chapter.data)));
    const doc = parse(decode(chapter.data)), style = doc.createElement("style");
    style.textContent = composeBookCss(meta); doc.getElementsByTagName("head")[0]!.appendChild(style);
    expect(result.html).toBe(isolate(encode(new XMLSerializer().serializeToString(doc))));
  }
  expect(result.html).toContain(composeBookCss(meta));
  expect(loadStaged(library, staged.token)).toEqual(staged); expect(library.listBooks()).toEqual([]); expect(library.db.listJobs()).toEqual([]);
});

it("decodes a GB18030 prefix using the ingest decoder", async () => {
  const bytes = Buffer.concat([Buffer.from("Chapter 1\n"), Buffer.from("d6d0cec4", "hex"), Buffer.from("\nChapter 2\nend")]);
  const staged = await stageUpload(library, new File([bytes], "gb.txt", { type: "text/plain" }));
  const result = success(page(staged.token)); expect(result.section_title).toBe("Chapter 1"); expect(result.html).toContain("中文"); expect(result.html).not.toContain("end");
});

it("switches rules and themes, retaining processor fallbacks for unknown IDs and TXT __book__", async () => {
  fs.writeFileSync(join(templateDirectory("rules"), "z-section.json"), JSON.stringify({ id: "section", chapter_patterns: ["^节.*$"] })); theme();
  const staged = await txt(`卷一\n节一 开始\n${prose}\n第一章 默认\n默认正文\n节二 继续\n后续正文`);
  expect(success(page(staged.token)).section_title).toBe("第一章 默认");
  expect(success(page(staged.token, "section")).section_title).toBe("节一 开始");
  const original = success(page(staged.token)), blue = success(page(staged.token, "default", "blue"));
  expect(blue.html).toContain("#123abc"); expect(original.html).not.toContain("#123abc"); expect(body(blue.html)).toBe(body(original.html));
  expect(page(staged.token, "missing", "missing")).toEqual(original); expect(page(staged.token, "default", "__book__")).toEqual(original);
});

it("skips non-linear, manifest nav, semantic cover/titlepage and link/heading-only documents", async () => {
  const staged = await stageEpub(epub([
    { name: "aside.xhtml", linear: "no", body: `<p>${prose}</p>` },
    { name: "menu.xhtml", properties: "nav", body: `<p>${prose}</p>` },
    { name: "front.xhtml", body: `<section epub:type="cover"><p>${prose}</p></section>` },
    { name: "title.xhtml", body: `<section epub:type="titlepage"><p>${prose}</p></section>` },
    { name: "front-title.xhtml", body: `<section role="doc-titlepage"><p>${prose}</p></section>` },
    { name: "contents.xhtml", body: `<h1>目录</h1><nav><a href="first.xhtml">${prose}</a></nav>` },
    { name: "heading.xhtml", body: `<h1>${prose}</h1><img src="cover.jpg"/>` },
    { name: "first.xhtml", body: `<h1>正文第一章</h1><div>${prose}</div>` },
    { name: "second.xhtml", body: `<p>不应出现${prose}</p>` },
  ]));
  const result = success(page(staged.token)); expect(result.section_title).toBe("正文第一章"); expect(result.volume_title).toBeNull(); expect(result.html).not.toContain("不应出现");
  const reads = vi.spyOn(ReaderArchive.prototype, "read"); success(page(staged.token));
  expect(reads.mock.calls.flat()).not.toContain("OPS/aside.xhtml");
  expect(reads.mock.calls.filter(([path]) => path === "OPS/menu.xhtml")).toHaveLength(1); // Landmarks only, never a candidate.
  expect(reads.mock.calls.flat()).not.toContain("OPS/second.xhtml");
});

it.each(["cover.xhtml", "title.xhtml", "nav.xhtml", "toc.xhtml"])("does not classify chapter content by its %s filename", async name => {
  const staged = await stageEpub(epub([{ name, body: `<h1>实际正文</h1><p>${prose}</p>` }, { name: "later.xhtml", body: `<p>${prose}</p>` }]));
  expect(success(page(staged.token)).section_title).toBe("实际正文");
});

it.each(['epub:type="bodymatter"', 'epub:type="text"', 'epub:type="chapter"', 'role="doc-chapter"'])("accepts a short semantic start before applying the prose threshold (%s)", async semantic => {
  const staged = await stageEpub(epub([
    { name: "front.xhtml", body: `<section epub:type="titlepage"><p>${prose}</p></section>` },
    { name: "tiny.xhtml", body: `<section ${semantic}><h1>短章</h1><p>寥寥数语。</p></section>` },
    { name: "long.xhtml", body: `<p>${prose}</p>` },
  ]));
  expect(success(page(staged.token)).section_title).toBe("短章");
});

it.each(["guide", "landmark"])("prioritizes an explicit %s start over earlier unmarked long prose", async hint => {
  const docs = [
    { name: "preface.xhtml", body: `<h1>前言</h1><p>${prose}</p>` },
    { name: "start.xhtml", body: "<h1>起点</h1><p>短章</p>" },
  ];
  if (hint === "landmark") docs.push({ name: "navigation.xhtml", body: '<nav epub:type="landmarks"><a epub:type="bodymatter" href="start.xhtml#start">开始</a></nav>', ...{ properties: "nav" } });
  const guide = hint === "guide" ? '<guide><reference type="text" href="start.xhtml#start"/></guide>' : "";
  const staged = await stageEpub(epub(docs, {}, [], guide));
  const reads = vi.spyOn(ReaderArchive.prototype, "read"), result = success(page(staged.token));
  expect(result.section_title).toBe("起点"); expect(reads.mock.calls.flat()).not.toContain("OPS/preface.xhtml");
});

it("skips guide and landmark front matter regardless of filenames", async () => {
  const docs = [
    { name: "a.xhtml", body: `<p>${prose}</p>` },
    { name: "b.xhtml", body: `<p>${prose}</p>` },
    { name: "c.xhtml", body: `<p>${prose}</p>` },
    { name: "d.xhtml", body: `<h1>正文</h1><p>${prose}</p>` },
    { name: "links.xhtml", properties: "nav", body: '<nav epub:type="landmarks"><a epub:type="cover" href="a.xhtml">封面</a><a epub:type="toc" href="c.xhtml">目录</a></nav>' },
  ];
  const guide = '<guide><reference type="title-page" href="b.xhtml"/></guide>';
  expect(success(page((await stageEpub(epub(docs, {}, [], guide))).token)).section_title).toBe("正文");
});

it("uses the named 24-letter/number threshold before the first-visible-text fallback", async () => {
  const staged = await stageEpub(epub([
    { name: "short.xhtml", body: `<p>${"字".repeat(23)} ... !!!</p>` },
    { name: "enough.xhtml", body: `<p>${"字".repeat(24)}</p>` },
  ]));
  expect(success(page(staged.token)).section_title).toBe("enough.xhtml");
});

it.each(["<p>短文</p>", "<h1>诗</h1>", "<a href='elsewhere.xhtml'>短链接</a>"])("falls back to the first linear non-nav document with visible text (%s)", async body => {
  const staged = await stageEpub(epub([
    { name: "aside.xhtml", linear: "no", body: `<p>${prose}</p>` },
    { name: "menu.xhtml", properties: "nav", body: `<p>${prose}</p>` },
    { name: "semantic-menu.xhtml", body: '<h1>目录</h1><section epub:type="toc"><p>内容</p></section>' },
    { name: "empty.xhtml", body: '<img src="image.png"/><script>not visible</script>' },
    { name: "cover.xhtml", body: `<h1>封面</h1><section epub:type="cover"><p>${prose}</p></section>` },
    { name: "title.xhtml", body: `<h1>扉页</h1><section role="doc-titlepage"><p>${prose}</p></section>` },
    { name: "tiny.xhtml", body },
    { name: "later.xhtml", body: "<p>后来</p>" },
  ]));
  const result = success(page(staged.token));
  expect(result.section_title).toBe(body.includes("<h1>") ? "诗" : "tiny.xhtml"); expect(result.html).not.toContain("后来");
});

it("keeps linked/imported/inline book CSS in __book__, and appends the same ingest theme overlay", async () => {
  theme();
  const bytes = epub([{ name: "first.xhtml", head: '<link rel="stylesheet" href="styles/book.css"/><style>p { margin: 3em; }</style>', body: `<h1>首章</h1><p style="text-indent: 1em">${prose}</p>` }], {
    "styles/book.css": '@import "base.css"; .book { color: maroon; }', "styles/base.css": "p { color: green; }",
  });
  const staged = await stageEpub(bytes), book = success(page(staged.token, "default", "__book__")), themed = success(page(staged.token, "default", "blue"));
  for (const result of [book, themed]) { expect(result.html).toContain("color: maroon"); expect(result.html).toContain("color: green"); expect(result.html).toContain("margin: 3em"); expect(result.html).not.toMatch(/<link\b/); }
  expect(book.html).not.toContain("#123abc"); expect(themed.html.indexOf("#123abc")).toBeGreaterThan(themed.html.indexOf("margin: 3em"));
  const meta = metadataFromDict({ source_type: "epub", theme_template: "blue" });
  const ingested = await stageEpub(updateEpubMetadata(bytes, meta, { css_text: composeBookCss(meta) }));
  expect(success(page(ingested.token, "default", "__book__")).html).toBe(themed.html);
});

it("tokenizes quoted, url(), escaped and commented imports, preserving media and relative recursion", async () => {
  const main = String.raw`/* @import "ignored.css"; */
@import/* separator */"quoted.css";
@import url("nested/base.css") screen and (min-width: 1px);
@import url(unquoted.css);
@\69mport "escaped\2e css";
@import u\72l(/* comment */'commented.css');
@import "cycle.css";
@import "missing.css";
@import "https://evil.test/outside.css";
@import "//evil.test/protocol.css";
.literal::before { content: '@import "ignored.css";'; }`;
  const styles = {
    "styles/main.css": main,
    "styles/quoted.css": ".quoted { color: red; }",
    "styles/unquoted.css": ".unquoted { color: navy; }",
    "styles/nested/base.css": '@import "../leaf.css" print; .nested { color: blue; }',
    "styles/leaf.css": ".leaf { color: green; }",
    "styles/escaped.css": ".escaped { color: purple; }",
    "styles/commented.css": ".commented { color: brown; }",
    "styles/cycle.css": '@import "main.css"; .cycle { color: orange; }',
    "styles/inline.css": ".inline { color: teal; }",
    "styles/ignored.css": ".never { color: pink; }",
  };
  const staged = await stageEpub(epub([{ name: "first.xhtml", body: `<p>${prose}</p>`, head: '<link rel="stylesheet" href="styles/main.css" media="screen"/><style>@import/* inline */"styles/inline.css" print;</style>' }], styles));
  const read = vi.spyOn(ReaderArchive.prototype, "read"), result = success(page(staged.token, "default", "__book__"));
  for (const selector of ["quoted", "unquoted", "nested", "leaf", "escaped", "commented", "cycle", "inline"]) expect(result.html).toContain(`.${selector} {`);
  expect(result.html).toContain("@media screen {"); expect(result.html).toContain("@media screen and (min-width: 1px)"); expect(result.html).toContain("@media print");
  expect(result.html).toContain('/* @import "ignored.css"; */'); expect(result.html).toContain(`content: '@import "ignored.css";'`);
  expect(result.html).not.toMatch(/evil\.test|missing\.css|\.never/);
  expect(read.mock.calls.filter(([path]) => path === "OPS/styles/main.css")).toHaveLength(1);
  expect(read.mock.calls.flat()).not.toContain("OPS/styles/ignored.css");
});

it("drops unsupported import qualifiers and limits CSS depth without treating strings as imports", async () => {
  const load = vi.fn(() => "p { color: red; }");
  expect(inlineCssImports('@import "a.css" layer(theme); @import "b.css" supports(display: grid);', load).trim()).toBe("");
  expect(load).not.toHaveBeenCalled();
  const styles = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`chain${i}.css`, `@import "chain${i + 1}.css"; .depth${i} { color: red; }`]));
  const staged = await stageEpub(epub([{ name: "first.xhtml", body: `<p>${prose}</p>`, head: '<link rel="stylesheet" href="chain0.css"/>' }], styles));
  const read = vi.spyOn(ReaderArchive.prototype, "read"), result = success(page(staged.token, "default", "__book__"));
  expect(result.html).toContain(".depth7"); expect(result.html).not.toContain(".depth8");
  expect(read.mock.calls.flat()).not.toContain("OPS/chain8.css");
});

it.each(["txt", "epub"])("sanitizes %s scripts, events, navigation and all asset URLs, including escaped CSS", async kind => {
  const attack = `<h1 onclick="alert(1)">首章</h1><p onmouseover="bad()" style="background: u\\72l(https://evil.test/a)">${prose}</p><script>alert(1)</script><iframe src="https://evil.test/frame"></iframe><img onerror="bad()" src="data:image/svg+xml,bad"/><a href="javascript:alert(1)">链接</a><a href="//evil.test/">外链</a><svg><image href="https://evil.test/svg"/></svg><form action="https://evil.test/post"><input/></form>`;
  const head = `<meta http-equiv="refresh" content="0;url=https://evil.test"/><base href="https://evil.test"/><style>@import "https://evil.test/a.css"; @font-face {font-family: Evil; src: url(data:font/woff;base64,AAAA)} p {background-image: image-set("https://evil.test/a.png" 1x, "relative-asset.png" 2x); fill: u\\72l(https://evil.test/a);}</style><style>p {background: url(https://evil.test/unclosed</style>`;
  const staged = kind === "txt" ? await txt(`第一章 安全\n${head}${attack}\n第二章 后续\n正文`) : await stageEpub(epub([{ name: "first.xhtml", head, body: attack }]));
  const result = success(page(staged.token, "default", "__book__"));
  expect(result.html).not.toMatch(/<(?:script|iframe|img|svg|form|input|base|link)\b|\son\w+=|evil\.test|relative-asset\.png|javascript:|data:font|data:image/i);
  expect(result.html).toContain("Content-Security-Policy"); expect(result.html).toContain("default-src 'none'"); expect(result.html).toContain(prose);
});

it("returns clean errors for bad/expired tokens, malformed input and invalid/empty documents", async () => {
  for (const token of ["../secret", "a".repeat(32), ""]) expect(page(token)).toHaveProperty("error", "上传暂存已失效，请重新选择文件后再预览。");
  const staged = await txt("第一章\n正文"); cleanupStaged(library, staged.token); expect(page(staged.token)).toHaveProperty("error");
  for (const input of [null, [], {}, { upload_token: 1, rule_id: "default", theme_id: "default" }]) expect(firstPagePreview(library, input)).toEqual({ error: "预览参数无效" });
  expect(page((await stageEpub(encode("not a zip"))).token)).toEqual({ error: "解析 EPUB 失败" });
  expect(page((await txt("")).token)).toEqual({ error: "空文件" });
  expect(page((await txt("  \n\t")).token)).toEqual({ error: "未找到可预览的正文章节" });
  expect(page((await stageEpub(epub([{ name: "empty.xhtml", body: "<img src='cover.jpg'/>" }]))).token)).toEqual({ error: "未找到可预览的正文章节" });
});

it("rejects oversized EPUB members even when their ZIP directory lies about the inflated size", async () => {
  const bytes = Buffer.from(writeArchive(readArchive(epub([{ name: "oversized.xhtml", body: `<p>${"正文".repeat(512 * 1024)}</p>` }]))));
  expect(page((await stageEpub(bytes)).token)).toEqual({ error: "文件过大，无法预览第一页" });
  let patched = false;
  for (let at = 0; at + 46 < bytes.length; at++) if (bytes.readUInt32LE(at) === 0x02014b50) {
    const length = bytes.readUInt16LE(at + 28);
    if (bytes.subarray(at + 46, at + 46 + length).toString() === "OPS/oversized.xhtml") { bytes.writeUInt32LE(128, at + 24); patched = true; break; }
  }
  expect(patched).toBe(true);
  const staged = await stageEpub(bytes);
  expect(page(staged.token)).toEqual({ error: "文件过大，无法预览第一页" });
  const archive = new ReaderArchive(staged.payload_path, fs.statSync(staged.payload_path, { bigint: true }), () => {});
  expect(() => archive.read("OPS/oversized.xhtml", 2 * 1024 * 1024)).toThrow(ReadLimitError);
});

it("distinguishes the total EPUB read budget and document scan limit from corrupt input", async () => {
  const styles = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`s${i}.css`, `/*${"x".repeat(1536 * 1024)}*/`]));
  const head = Object.keys(styles).map(href => `<link rel="stylesheet" href="${href}"/>`).join("");
  const staged = await stageEpub(epub([{ name: "first.xhtml", body: `<p>${prose}</p>`, head }], styles));
  expect(page(staged.token)).toEqual({ error: "文件过大，无法预览第一页" });
  const docs = Array.from({ length: 65 }, (_, i) => ({ name: `c${i}.xhtml`, body: i === 64 ? `<p>${prose}</p>` : "<p>短文</p>" }));
  expect(page((await stageEpub(epub(docs))).token)).toEqual({ error: "文件过大，无法预览第一页" });
  expect(page((await stageEpub(encode("corrupt"))).token)).toEqual({ error: "解析 EPUB 失败" });
});

it("authenticates before parsing JSON and serves no-store JSON on toolbar requests", async () => {
  const handler = vi.fn(({ request, library }: { request: Request; library: LibraryStorage }) => firstPageResponse(request, library));
  const route = authenticatedRoute(handler, () => library);
  const anonymous = await route({ request: new Request("https://example.test/ingest/first-page", { method: "POST", body: "invalid" }), params: {} });
  expect(anonymous.status).toBe(303); expect(handler).not.toHaveBeenCalled();
  const token = (await txt(`第一章\n${prose}`)).token;
  const headers = { Cookie: `bindery_session=${signIn(library.db)}`, "Content-Type": "application/json" };
  const response = await route({ request: new Request("https://example.test/ingest/first-page", { method: "POST", headers, body: JSON.stringify({ upload_token: token, rule_id: "default", theme_id: "default" }) }), params: {} });
  expect(response.headers.get("Cache-Control")).toBe("no-store"); expect(await response.json()).toEqual(page(token));
  const bad = await route({ request: new Request("https://example.test/ingest/first-page", { method: "POST", headers, body: "invalid" }), params: {} });
  expect(bad.status).toBe(400); expect(await bad.json()).toEqual({ error: "预览参数无效" });
});

it("keeps unbounded line/event parsing exhaustive beyond preview ceilings", () => {
  const text = `Chapter 1\n${"正文\n".repeat(80000)}Chapter 2\n最后标记`;
  const path = join(dir, "complete.txt"); fs.writeFileSync(path, text);
  const lines = [...decodedFileLines(path, "utf8")]; expect(lines.at(-1)).toBe("最后标记"); expect(lines).toHaveLength(80003);
  const read = vi.spyOn(fs, "readSync").mockClear(), events = [...parseBookFileEvents(path, "sample")];
  expect(events).toEqual([...parseBookEvents(text, "sample")]);
  expect(JSON.stringify(events.at(-1))).toContain("最后标记");
  const bytesRead = read.mock.results.reduce((n, result) => n + (result.type === "return" ? Number(result.value) : 0), 0);
  expect(bytesRead).toBeGreaterThanOrEqual(Buffer.byteLength(text) * 2);
});

it("rejects truncated final multibyte sequences in strict decoders, retaining master's event-parser replacement fallback", () => {
  for (const fixture of masterFixture.truncated) {
    const bytes = Buffer.from(fixture.hex, "hex"), path = join(dir, "truncated.txt"); fs.writeFileSync(path, bytes);
    for (const encoding of ["utf8", "gb18030"] as const) expect(() => [...decodedFileLines(path, encoding)]).toThrow(TypeError);
    expect([...parseBookFileEvents(path, "sample")]).toEqual(fixture.events);
    expect(JSON.stringify(fixture.events.at(-1))).toContain("�");
    // The same invalid tail beyond the preview ceiling must participate in encoding selection.
    const long = Buffer.concat([Buffer.from(`Chapter 1\n${"line\n".repeat(80000)}`), bytes]); fs.writeFileSync(path, long);
    expect(() => [...decodedFileLines(path, "utf8")]).toThrow(TypeError);
    expect([...parseBookFileEvents(path, "sample")].at(-1)).toEqual(fixture.events.at(-1));
  }
});

it.each(["stored", "deflated"])("keeps unbounded ReaderArchive.read unchanged for %s members", compression => {
  const bytes = encode("完整内容".repeat(200000)), path = join(dir, "unbounded.epub");
  fs.writeFileSync(path, writeArchive([{ name: "large.txt", data: bytes }, { name: "empty.txt", data: new Uint8Array() }], compression === "stored" ? null : undefined));
  const archive = new ReaderArchive(path, fs.statSync(path, { bigint: true }), () => {});
  const first = archive.read("large.txt")!;
  expect(Buffer.isBuffer(first)).toBe(compression === "stored");
  expect(Buffer.from(first).equals(Buffer.from(bytes))).toBe(true);
  expect(archive.read("empty.txt")).toHaveLength(0); expect(archive.read("missing.txt")).toBeUndefined();
  expect(archive.read("empty.txt", 0)).toHaveLength(0);
  expect(() => archive.read("large.txt", 2 * 1024 * 1024)).toThrow(ReadLimitError);
  expect(Buffer.from(archive.read("large.txt")!).equals(Buffer.from(bytes))).toBe(true);
});

it("matches master-generated ordinary reader HTML byte-for-byte, with and without a resolver", () => {
  const fixture = masterFixture.reader;
  expect(isolatedBookHtml(encode(fixture.html), fixture.baseHref, fixture.requestUrl)).toBe(fixture.expectedDefault);
  const resolve = (url: string) => (fixture.resolved as Record<string, string>)[url] ?? null;
  expect(isolatedBookHtml(encode(fixture.html), fixture.baseHref, fixture.requestUrl, resolve)).toBe(fixture.expectedResolved);
});

it("reads only a prefix of 20 MiB TXT, closes the early iterator and reports timings", async () => {
  const prefix = `卷一\n第一章 开始\n${prose}\n第二章 之后\n`;
  const text = prefix + "后续正文\n".repeat(Math.ceil((20 * 1024 * 1024 - Buffer.byteLength(prefix)) / Buffer.byteLength("后续正文\n")));
  const staged = await txt(text); expect(staged.size).toBeGreaterThan(20 * 1024 * 1024);
  const read = vi.spyOn(fs, "readSync").mockClear(), close = vi.spyOn(fs, "closeSync").mockClear();
  const start = performance.now(); const first = success(page(staged.token)); const coldMs = performance.now() - start;
  expect(first.html).not.toContain("后续正文");
  const bytesRead = read.mock.results.reduce((n, result) => n + (result.type === "return" ? Number(result.value) : 0), 0);
  expect(bytesRead).toBeLessThanOrEqual(128 * 1024); expect(close.mock.calls.length).toBeGreaterThanOrEqual(2);
  vi.restoreAllMocks();
  const times = Array.from({ length: 7 }, () => { const start = performance.now(); success(page(staged.token)); return performance.now() - start; });
  console.info("INGEST_FIRST_PAGE_TXT", JSON.stringify({ size: staged.size, bytesRead, coldMs, medianMs: [...times].sort((a, b) => a - b)[3], maxMs: Math.max(...times) }));
});

it("reports TXT limit failures rather than returning a truncated chapter or prelude", async () => {
  for (const prefix of ["第一章 开始\n", ""]) {
    const staged = await txt(prefix + `${prose}\n`.repeat(20000));
    const read = vi.spyOn(fs, "readSync").mockClear();
    expect(page(staged.token)).toEqual({ error: "文件过大，无法预览第一页" });
    const bytes = read.mock.results.reduce((n, result) => n + (result.type === "return" ? Number(result.value) : 0), 0);
    expect(bytes).toBeLessThanOrEqual(320 * 1024); vi.restoreAllMocks();
    expect(() => [...parseBookFileEvents(staged.payload_path, "sample", undefined, { maxBytes: 256 * 1024 })]).toThrow(ReadLimitError);
  }
});

it("uses indexed reads on a generated 21 MiB EPUB with 2000 chapters and reports timings", async () => {
  const docs = Array.from({ length: 2000 }, (_, i) => ({ name: `c${i}.xhtml`, head: '<link rel="stylesheet" href="style.css"/>', body: `<h1>第${i + 1}章</h1><p>${prose}${"正文".repeat(1800)}</p>` }));
  const bytes = epub(docs, { "style.css": "p { line-height: 1.7; }" }); expect(bytes.length).toBeGreaterThan(21 * 1024 * 1024);
  const staged = await stageEpub(bytes), read = vi.spyOn(ReaderArchive.prototype, "read");
  const start = performance.now(); success(page(staged.token)); const coldMs = performance.now() - start;
  expect(read.mock.calls.map(([path]) => path)).toEqual(["META-INF/container.xml", "OPS/book.opf", "OPS/c0.xhtml", "OPS/style.css"]);
  vi.restoreAllMocks();
  const times = Array.from({ length: 7 }, () => { const start = performance.now(); success(page(staged.token)); return performance.now() - start; });
  console.info("INGEST_FIRST_PAGE_EPUB", JSON.stringify({ size: bytes.length, chapters: docs.length, memberReads: 4, coldMs, medianMs: [...times].sort((a, b) => a - b)[3], maxMs: Math.max(...times) }));
});
