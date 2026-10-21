import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import fixtures from "./fixtures/books/lookup.json";
import {
  fetchText,
  authorMatchScore,
  titleMatchScore,
  parseDoubanSubjectHtml,
  parseAmazonProductHtml,
  lookupBookMetadataVerbose,
  lookupBookMetadataCandidates,
  lookupAmazon,
  lookupMetadata,
  metadataScore,
  mergeMetadata,
  USER_AGENT,
  type Fetch,
} from "../src/server/books/metadata-lookup";
import {
  validateCss,
  formatCssText,
  MAX_CSS_LENGTH,
} from "../src/features/books/css";
const references = JSON.parse(
  readFileSync(resolve("tests-ts/fixtures/parity/metadata/reference.json"), "utf8"),
) as { lookup: unknown[]; scores: unknown[]; css: (string | null)[] };
const parsed = fixtures.map((row) =>
  (row.source === "douban" ? parseDoubanSubjectHtml : parseAmazonProductHtml)(
    row.html,
  ),
);
describe("offline metadata parsing and legacy parity", () => {
  it("matches every original Douban/Amazon HTML fixture field", async () => {
    expect(parsed).toEqual(references.lookup);
  });
  it.each(fixtures.map((row, i) => [row.name, parsed[i]] as const))(
    "ports %s",
    (_name, meta) => {
      expect(meta.source).toMatch(/douban|amazon/);
      expect(
        meta.title || meta.description || meta.cover_url || meta.publisher,
      ).toBeTruthy();
    },
  );
  it("prefers tag anchors, then criteria, then JSON keywords", () => {
    expect(parsed[1].tags).toEqual(["小说", "悬疑"]);
    expect(parsed[2].tags).toEqual(["小说", "文学", "悬疑"]);
    expect(parsed[0].tags).toEqual(["Sci-Fi", "Space"]);
  });
  it("uses the final expanded intro with paragraphs and line breaks", () => {
    expect(parsed[3].description).toBe(
      "完整简介第一段。\n\n完整简介第二段。\n换行继续。",
    );
  });
  it("prefers nbg href over OpenGraph and retains publisher spaces", () => {
    expect(parsed[4].cover_url).toContain("s7654321");
    expect(parsed[5].cover_url).toContain("s1234567");
    expect(parsed[6].publisher).toBe("Random House Children's Books");
  });
  it("covers JSON lists, descriptions, images, malformed scripts and entities", () => {
    const html = `<script type='application/ld+json'>broken</script><script type='application/ld+json'>[{"@type":["Thing","Book"],"name":"A &amp; B","author":[{"name":"一"},"二"],"description":[{"@value":"简介"},{"text":"第二段"}],"image":[{"url":"//img.test/one.png"}],"keywords":"A,A，B;C|D/E","isbn":"ISBN: 978-0123456789","datePublished":"出版于2024-2-1"}]</script>`;
    expect(parseDoubanSubjectHtml(html)).toMatchObject({
      title: "A & B",
      author: "一, 二",
      description: "简介\n第二段",
      cover_url: "https://img.test/one.png",
      tags: ["A", "B", "C", "D", "E"],
      published: "2024-2-1",
      isbn: "978-0123456789",
    });
  });
  it("uses Amazon bullets and avoids promotional meta descriptions", () => {
    expect(
      parseAmazonProductHtml(
        `<div id='feature-bullets'><span class='a-list-item'>This is a useful long bullet.</span><span class='a-list-item'>This is a useful long bullet.</span></div>`,
      ).description,
    ).toBe("- This is a useful long bullet.");
    expect(
      parseAmazonProductHtml(
        `<meta name='description' content='Amazon.com: Buy books'/>`,
      ).description,
    ).toBeNull();
  });
  it("keeps Amazon fallback title and ISBN10/RPI fields", () => {
    expect(
      parseAmazonProductHtml(
        `<meta name='title' content='Amazon.com: Example: 1234567890: Books'/><div id='rpi-attribute-book_details-isbn10'><div class='rpi-attribute-value'><span>123456789X</span></div></div>`,
      ),
    ).toMatchObject({ title: "Example", isbn: "123456789X" });
  });
});
describe("source selection, matching and transport", () => {
  it("matches legacy title/author scoring including token ordering and multi-author names", async () => {
    const cases = [
      { title: "三体", query: "三体", author: "刘慈欣", expected: "刘慈欣" },
      {
        title: "三体全集",
        query: "三体",
        author: "张三 / 刘慈欣",
        expected: "刘慈欣",
      },
      {
        title: "Dune",
        query: "Children of Dune",
        author: "Osborne Mary Pope",
        expected: "Mary Pope Osborne",
      },
      {
        title: "ABCD",
        query: "ABEF",
        author: "Mary Pope",
        expected: "Mary Pope Osborne",
      },
      { title: "一", query: "", author: "", expected: "刘慈欣" },
      { title: "不匹配", query: "三体", author: "李四", expected: "刘慈欣" },
      { title: "三体", query: "三体", author: "Cixin Liu", expected: "" },
    ];
    expect(
      cases.map((c) => ({
        title: titleMatchScore(c.title, c.query),
        author: authorMatchScore(c.author, c.expected),
      })),
    ).toEqual(references.scores);
  });
  it("selects matching author before title similarity and requests only Douban", async () => {
    const calls: string[] = [],
      fetcher: Fetch = async (url, init) => {
        calls.push(url);
        expect(new Headers(init?.headers).get("User-Agent")).toBe(USER_AGENT);
        return Response.json(
          url.includes("subject_suggest")
            ? [
                { id: "1", title: "三体", author_name: "张三" },
                { id: "2", title: "三体", author_name: "刘慈欣", year: "2008" },
              ]
            : {},
        );
      };
    const result = await lookupBookMetadataVerbose("三体", {
      author: "刘慈欣",
      fetch: fetcher,
    });
    expect(calls).toEqual([
      "https://book.douban.com/j/subject_suggest?q=%E4%B8%89%E4%BD%93",
      "https://book.douban.com/subject/2/",
    ]);
    expect(result.best).toMatchObject({ author: "刘慈欣", published: "2008" });
    expect(result.errors).toEqual([]);
    expect(result.attempts[0].selected).toBe(true);
  });
  it("rejects conflicting authors without fetching detail or Amazon", async () => {
    const fake = vi.fn<Fetch>(async () =>
      Response.json([
        { id: "1", title: "三体", author_name: "张三" },
        { id: "2", title: "三体", author_name: "李四" },
      ]),
    );
    const result = await lookupBookMetadataVerbose("三体", {
      author: "刘慈欣",
      fetch: fake,
    });
    expect(result.best).toBeNull();
    expect(result.errors).toEqual(["douban: 未找到作者匹配的豆瓣条目"]);
    expect(result.attempts[0]).toMatchObject({
      ok: false,
      selected: false,
      error: "未找到作者匹配的豆瓣条目",
    });
    expect(fake).toHaveBeenCalledOnce();
  });
  it("allows suggestions without author metadata, preserving first equal rank", async () => {
    const fake = vi.fn<Fetch>(async () =>
      Response.json([
        { title: "三体", year: "2001" },
        { title: "三体", year: "2008" },
      ]),
    );
    expect(
      (
        await lookupBookMetadataVerbose("三体", {
          author: "刘慈欣",
          fetch: fake,
        })
      ).best?.published,
    ).toBe("2001");
  });
  it.each([[], {}, [null, 1, "x"]])(
    "handles empty or invalid suggestion payload %j",
    async (value) => {
      const result = await lookupBookMetadataVerbose("书", {
        fetch: async () => Response.json(value),
      });
      expect(result.best).toBeNull();
      expect(result.attempts[0].error).toBe("未命中");
    },
  );
  it("reports failed source and never falls back to Amazon", async () => {
    const fake = vi.fn<Fetch>(async () => {
      throw new Error("blocked");
    });
    const result = await lookupBookMetadataVerbose("Dune", { fetch: fake });
    expect(result.errors).toEqual(["douban: blocked"]);
    expect(result.attempts[0]).toMatchObject({ ok: false, error: "blocked" });
    expect(fake).toHaveBeenCalledOnce();
  });
  it("returns empty query error without transport", async () => {
    const fake = vi.fn<Fetch>();
    expect(await lookupBookMetadataCandidates(" ", { fetch: fake })).toEqual({
      candidates: {},
      best_source: null,
      errors: ["空标题无法检索"],
      attempts: [],
    });
    expect(fake).not.toHaveBeenCalled();
  });
  it("merges detail fields while retaining suggestion values and isolates tags", () => {
    const primary = lookupMetadata("douban", { title: "书", tags: ["A"] }),
      overlay = lookupMetadata("other", { author: "作者" });
    const merged = mergeMetadata(primary, overlay);
    expect(merged).toMatchObject({
      source: "douban",
      title: "书",
      author: "作者",
      tags: ["A"],
    });
    expect(merged.tags).not.toBe(primary.tags);
    expect(metadataScore(primary, "书")).toBe(13);
  });
  it("retains the full Amazon lookup API without enabling automatic Amazon lookup", async () => {
    const urls: string[] = [];
    const value = await lookupAmazon("Dune", 8, async (url) => {
      urls.push(url);
      return new Response(
        url.includes("/s?")
          ? `<div data-asin="ABCDEFGHIJ"></div>`
          : `<span id='productTitle'>Dune</span>`,
      );
    });
    expect(urls).toEqual([
      "https://www.amazon.com/s?k=Dune&i=stripbooks",
      "https://www.amazon.com/dp/ABCDEFGHIJ",
    ]);
    expect(value?.title).toBe("Dune");
  });
  it("honors declared HTML charset and exposes HTTP failures", async () => {
    expect(
      await fetchText(
        "https://example.com/html",
        8,
        async () =>
          new Response(Buffer.from("简介", "utf16le"), {
            headers: { "Content-Type": "text/html; charset=utf-16le" },
          }),
      ),
    ).toBe("简介");
    const result = await lookupBookMetadataVerbose("书", {
      fetch: async () =>
        new Response(null, { status: 403, statusText: "Forbidden" }),
    });
    expect(result.errors[0]).toContain("HTTP Error 403");
  });
});
const cssCases = [
  "",
  "   ",
  "body { color: red; }",
  "body { color: red;",
  "} body { color: red; }",
  'body { content: "oops; }',
  "/* comment",
  "a".repeat(MAX_CSS_LENGTH + 1),
  "\0",
  'a{content:"{}";/* {} */}',
  "a{content:'\\\'';}",
  "😀".repeat(100_001),
];
describe("book CSS validation and formatting", () => {
  it("matches legacy validation messages including Unicode character counts", async () => {
    expect(cssCases.map(validateCss)).toEqual(references.css);
  });
  it.each(cssCases.slice(0, 10).map((raw, i) => [i, raw] as const))(
    "validates case %i",
    (i, raw) => {
      expect(validateCss(raw) === null).toBe([0, 1, 2, 9].includes(i));
    },
  );
  it("formats blocks and nested rules without changing strings, comments or data URLs", () => {
    const raw =
      '@media print{a{color:red;content:"a;b{}";background:url(data:image/svg+xml;x);}}';
    const formatted = formatCssText(raw);
    expect(formatted).toContain('content:"a;b{}";');
    expect(formatted).toContain("url(data:image/svg+xml;x)");
    expect(formatted).toContain("\n  a {\n    color:red;");
    expect(validateCss(formatted)).toBeNull();
    expect(formatCssText("/* keep */a{color:red;}")).toContain("/* keep */");
  });
});
