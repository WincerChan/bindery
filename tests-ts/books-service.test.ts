import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { metadataFromDict, bookFromDict } from "../src/core/models";
import { buildEpub, extractCover, extractEpubMetadata } from "../src/core/epub";
import {
  LibraryStorage,
  saveBook,
  bookDir,
  epubPath,
  archiveBookDir,
  coverPath,
} from "../src/server/storage";
import { BinderyDatabase } from "../src/server/db";
import {
  loadBookPage,
  saveBookEdit,
  fetchBookMetadata,
  setReadStatus,
  archiveBook,
  restoreBook,
  deleteBook,
  lookupResultView,
  parseRating,
  parseTags,
  type SubmitEditWriteback,
} from "../src/server/books/service";
import {
  replaceCover,
  extractBookCover,
  writeBookEpub,
  validateCover,
  downloadCoverFromUrl,
  uploadedCover,
  MAX_COVER_BYTES,
} from "../src/server/books/covers";
import {
  USER_AGENT,
  lookupMetadata,
  type Fetch,
} from "../src/server/books/metadata-lookup";
import {
  safeInternalTarget,
  bookNavigation,
} from "../src/features/books/navigation";
import { authenticatedRoute } from "../src/server/http";
import { signIn } from "../src/server/auth";
const root = mkdtempSync(join(tmpdir(), "bindery-books-service-")),
  id = "a".repeat(32);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X4D1kAAAAASUVORK5CYII=",
  "base64",
);
let seq = 0,
  library: LibraryStorage;
const previousTemplate = process.env.BINDERY_TEMPLATE_DIR,
  previousQueue = process.env.BINDERY_INGEST_QUEUE_MAXSIZE;
beforeEach(() => {
  const path = join(root, String(seq++));
  library = new LibraryStorage(
    join(path, "library"),
    new BinderyDatabase(join(path, "data.db")),
  );
  library.ensure();
  process.env.BINDERY_TEMPLATE_DIR = join(path, "templates");
  delete process.env.BINDERY_INGEST_QUEUE_MAXSIZE;
});
afterAll(() => {
  if (previousTemplate === undefined) delete process.env.BINDERY_TEMPLATE_DIR;
  else process.env.BINDERY_TEMPLATE_DIR = previousTemplate;
  if (previousQueue === undefined)
    delete process.env.BINDERY_INGEST_QUEUE_MAXSIZE;
  else process.env.BINDERY_INGEST_QUEUE_MAXSIZE = previousQueue;
  rmSync(root, { recursive: true, force: true });
});
function seed(source = "epub") {
  const book = bookFromDict({
    title: "示例书",
    author: "作者",
    root_chapters: [{ title: "第一章", lines: ["hello"] }],
  });
  const meta = metadataFromDict({
    book_id: id,
    title: "示例书",
    author: "作者",
    source_type: source,
    created_at: "2026-02-06T00:00:00+00:00",
    updated_at: "2026-02-06T00:00:00+00:00",
    epub_updated_at: "2026-02-06T00:00:00+00:00",
  });
  saveBook(book, library.base, id);
  library.saveMetadata(meta);
  writeFileSync(epubPath(library.base, id), buildEpub(book, meta));
  return meta;
}
function form(values: Record<string, string> = {}) {
  const f = new FormData();
  for (const [k, v] of Object.entries({
    title: "示例书",
    author: "作者",
    language: "zh-CN",
    ...values,
  }))
    f.set(k, v);
  return f;
}
describe("book detail, editing and tracker state", () => {
  it("returns serializable view and template choices with safe return navigation", () => {
    seed();
    const page = loadBookPage(id, "/?q=书&page=3", library);
    expect(page.navigation.preview_url).toContain("return_to=%2F%3Fq%3D");
    expect(page.book.can_regenerate).toBe(false);
    expect(page.rules[0]).toHaveProperty("rule_id");
    expect(page.themes[0]).toHaveProperty("theme_id");
    expect(JSON.parse(JSON.stringify(page))).toEqual(page);
  });
  it("reuses a manual tracker with normalized title and compatible author", () => {
    seed();
    library.db.createWish({
      id: "b".repeat(32),
      title: "示例-书",
      author: null,
      library_book_id: null,
      rating: 4,
      read: true,
      read_status: "read",
      tags: ["保留"],
      comment: "保留",
      book_status: "reading",
      created_at: "old",
      updated_at: "old",
    });
    const page = loadBookPage(id, "/", library);
    expect(page.book).toMatchObject({
      read: true,
      rating: 4,
      status_label: "已写回元数据",
    });
    expect(library.db.listWishes()).toHaveLength(1);
    expect(library.db.listWishes()[0]).toMatchObject({
      library_book_id: id,
      comment: "保留",
      tags: ["保留"],
    });
  });
  it("does not attach a conflicting author's manual tracker", () => {
    seed();
    library.db.createWish({
      id: "b".repeat(32),
      title: "示例书",
      author: "别的作者",
      library_book_id: null,
      rating: 4,
      read: true,
      read_status: "read",
      tags: [],
      comment: null,
      book_status: "completed",
      created_at: "old",
      updated_at: "old",
    });
    loadBookPage(id, "/", library);
    expect(library.db.listWishes()).toHaveLength(2);
  });
  it.each(["1", "true", " YES ", "on"])(
    "sets read for %s without modifying EPUB writeback timestamps",
    (value) => {
      seed();
      const before = readFileSync(epubPath(library.base, id));
      setReadStatus(id, value, library);
      const meta = library.loadMetadata(id);
      expect(meta).toMatchObject({
        read: true,
        updated_at: "2026-02-06T00:00:00+00:00",
        epub_updated_at: "2026-02-06T00:00:00+00:00",
        status: "synced",
      });
      expect(meta.read_updated_at).toBeTruthy();
      expect(library.db.getWishByLibraryBookId(id)?.read_status).toBe("read");
      expect(readFileSync(epubPath(library.base, id))).toEqual(before);
    },
  );
  it("sets unread for all other flags and leaves read timestamp stable when unchanged", () => {
    seed();
    setReadStatus(id, "1", library);
    setReadStatus(id, "0", library);
    const time = library.loadMetadata(id).read_updated_at;
    setReadStatus(id, "arbitrary", library);
    expect(library.loadMetadata(id).read).toBe(false);
    expect(library.loadMetadata(id).read_updated_at).toBe(time);
  });
  it("saves form metadata in SQLite, synchronizes tracker and queues edit-writeback", async () => {
    seed();
    const result = await saveBookEdit(
      id,
      form({
        title: " 新书 ",
        author: " 新作者 ",
        language: "",
        description: " 简介 ",
        series: " 系列 ",
        publisher: " 社 ",
        tags: "一, 二，二",
        published: "2024-01-02",
        isbn: "1234567890",
        rating: "9",
        rule_template: "ignored",
        theme_template: "__book__",
        custom_css: " body {color:red;} ",
        return_to: "/?page=3",
      }),
      library,
    );
    expect(result).toMatchObject({ queued: true, kind: "success" });
    expect(library.loadMetadata(id)).toMatchObject({
      title: "新书",
      author: "新作者",
      language: "zh-CN",
      description: "简介",
      series: "系列",
      publisher: "社",
      tags: ["一", "二", "二"],
      published: "2024-01-02",
      isbn: "1234567890",
      rating: 5,
      rule_template: null,
      theme_template: "__book__",
      custom_css: "body {color:red;}",
      status: "dirty",
    });
    expect(library.db.getWishByLibraryBookId(id)).toMatchObject({
      title: "新书",
      author: "新作者",
      rating: 5,
    });
    expect(library.db.listJobs()[0]).toMatchObject({
      action: "edit-writeback",
      stage: "排队中",
      book_id: id,
    });
    expect(existsSync(join(bookDir(library.base, id), "meta.json"))).toBe(
      false,
    );
  });
  it("keeps identifier unless explicitly supplied and handles blank title/language", async () => {
    const meta = seed("txt");
    meta.identifier = "keep";
    library.saveMetadata(meta);
    await saveBookEdit(
      id,
      form({
        title: "",
        language: "",
        theme_template: "__book__",
        rule_template: "special",
      }),
      library,
    );
    expect(library.loadMetadata(id)).toMatchObject({
      title: "示例书",
      language: "zh-CN",
      identifier: "keep",
      theme_template: "default",
      rule_template: "special",
    });
    await saveBookEdit(id, form({ identifier: "" }), library);
    expect(library.loadMetadata(id).identifier).toBeNull();
  });
  it("rejects invalid CSS without saving or queueing, retaining draft fields", async () => {
    seed();
    const before = library.loadMetadata(id);
    const result = await saveBookEdit(
      id,
      form({ title: "draft", rating: "4", custom_css: "a{" }),
      library,
    );
    expect(result.page.error).toBe("自定义 CSS 校验失败：CSS 花括号不匹配");
    expect(result.page.book.title).toBe("draft");
    expect(result.page.book.rating).toBe(4);
    expect(library.loadMetadata(id)).toEqual(before);
    expect(library.db.listJobs()).toEqual([]);
  });
  it("returns empty uploaded cover error without saving metadata", async () => {
    seed();
    const f = form({ title: "draft" });
    f.set("cover_file", new File([], "cover.png"));
    expect((await saveBookEdit(id, f, library)).page.error).toBe(
      "封面文件为空",
    );
    expect(library.loadMetadata(id).title).toBe("示例书");
  });
  it("reports queue-full truthfully while preserving saved dirty metadata", async () => {
    seed();
    process.env.BINDERY_INGEST_QUEUE_MAXSIZE = "1";
    await saveBookEdit(id, form(), library);
    const result = await saveBookEdit(id, form({ title: "保存了" }), library);
    expect(result).toMatchObject({ queued: false, kind: "error" });
    expect(result.message).toContain("创建失败");
    expect(library.loadMetadata(id)).toMatchObject({
      title: "保存了",
      status: "dirty",
    });
    expect(library.db.listJobs().map((j) => j.status)).toContain("failed");
  });
  it("durably queues rich writeback options with the production submitter", async () => {
    seed();
    expect(await saveBookEdit(id, form({ title: "已保存", cover_url: "https://example.com/a.png" }), library)).toMatchObject({ queued: true });
    expect(library.loadMetadata(id).title).toBe("已保存");
    expect(await saveBookEdit(id, form({ strip_original_css: "1" }), library)).toMatchObject({ queued: true });
    expect(library.db.listJobs()).toHaveLength(2);
  });
  it("defines injectable submission carrying cover bytes, URL and one-shot CSS flags", async () => {
    seed();
    const submit = vi.fn<SubmitEditWriteback>(async (_meta, options) => {
      expect(options.cover_bytes).toEqual(new Uint8Array(png));
      expect(options.cover_name).toBe("cover.png");
      expect(options.cover_url).toBe("https://example.com/a.png");
      expect(options.strip_original_css).toBe(true);
      return { queued: true };
    });
    const f = form({
      cover_url: "https://example.com/a.png",
      strip_original_css: "on",
    });
    f.set("cover_file", new File([png], "cover.png"));
    expect((await saveBookEdit(id, f, library, submit)).queued).toBe(true);
    expect(submit).toHaveBeenCalledOnce();
  });
  it.each(["-1", "0", "3", "9", "2.5", "not a number", ""])(
    "ports rating parsing for %s",
    (raw) => {
      expect(parseRating(raw)).toBe(
        ({ "-1": 0, "0": 0, "3": 3, "9": 5 } as Record<string, number>)[raw] ??
          null,
      );
    },
  );
  it("retains tag order and duplicates as legacy does", () => {
    expect(parseTags("a， b,a,, ")).toEqual(["a", "b", "a"]);
  });
});
describe("metadata fetch is an unsaved edit draft", () => {
  const fetcher: Fetch = async (url) =>
    url.includes("subject_suggest")
      ? Response.json([{ title: "线上书", author_name: "作者", id: "1" }])
      : new Response(
          `<script type="application/ld+json">{"@type":"Book","name":"线上书","author":{"name":"作者"},"description":"线上简介","image":"https://img.test/cover.jpg","publisher":{"name":"线上出版社"},"keywords":"文学,小说"}</script>`,
        );
  it("fills nonempty metadata and cover URL while leaving SQLite and EPUB unchanged", async () => {
    seed();
    const before = library.loadMetadata(id),
      bytes = readFileSync(epubPath(library.base, id));
    const result = await fetchBookMetadata(
      id,
      form({
        series: "手填系列",
        rating: "3",
        custom_css: "a{}",
        return_to: "/?q=书",
      }),
      library,
      fetcher,
    );
    expect(result.book).toMatchObject({
      title: "线上书",
      description: "线上简介",
      publisher: "线上出版社",
      tags: ["文学", "小说"],
      series: "手填系列",
      rating: 3,
      cover_fetch_url: "https://img.test/cover.jpg",
      custom_css: "a{}",
    });
    expect(result.lookup_changed_fields).toContain("cover_url");
    expect(result.lookup_result).toMatchObject({
      cover_url: "https://img.test/cover.jpg",
      applied_cover_url: "https://img.test/cover.jpg",
    });
    expect(library.loadMetadata(id)).toEqual(before);
    expect(readFileSync(epubPath(library.base, id))).toEqual(bytes);
    expect(library.db.listJobs()).toEqual([]);
  });
  it.each(["stored", "manual"])(
    "preserves %s cover while showing source and applied URLs separately",
    async (mode) => {
      const meta = seed();
      if (mode === "stored") {
        meta.cover_file = "cover.png";
        library.saveMetadata(meta);
      }
      const result = await fetchBookMetadata(
        id,
        form(
          mode === "manual"
            ? { cover_url: "https://example.com/manual.png" }
            : {},
        ),
        library,
        fetcher,
      );
      expect(result.lookup_allow_cover_fill).toBe(false);
      expect(result.lookup_changed_fields).not.toContain("cover_url");
      expect(result.lookup_result?.cover_url).toBe(
        "https://img.test/cover.jpg",
      );
      expect(result.lookup_result?.applied_cover_url).toBe(
        mode === "manual" ? "https://example.com/manual.png" : "",
      );
    },
  );
  it("falls back to the selected source for inherited object property names", async () => {
    seed();
    for (const metadata_source of ["toString", "__proto__", "constructor"]) {
      const result = await fetchBookMetadata(
        id,
        form({ metadata_source }),
        library,
        fetcher,
      );
      expect(result.book.title).toBe("线上书");
      expect(result.lookup_selected_source).toBe("douban");
    }
  });
  it("retains draft form fields and error attempts when lookup fails", async () => {
    seed();
    const page = await fetchBookMetadata(
      id,
      form({
        title: "草稿",
        series: "系列",
        rating: "4",
        theme_template: "__book__",
        strip_original_css: "1",
      }),
      library,
      async () => {
        throw new Error("blocked");
      },
    );
    expect(page.error).toBe("未能从豆瓣获取元数据：douban: blocked");
    expect(page.book).toMatchObject({
      title: "草稿",
      series: "系列",
      rating: 4,
      theme_template: "__book__",
    });
    expect(page.strip_original_css).toBe(true);
    expect(page.lookup_attempts?.[0].error).toBe("blocked");
  });
  it("ports lookup result source/applied cover separation", () => {
    expect(
      lookupResultView(
        "示例书",
        "豆瓣",
        {
          title: "示例书",
          cover_fetch_url: "https://example.com/applied.jpg",
          tags: ["小说"],
        },
        [],
        "https://example.com/source.jpg",
      ),
    ).toMatchObject({
      cover_url: "https://example.com/source.jpg",
      applied_cover_url: "https://example.com/applied.jpg",
    });
  });
});
describe("cover persistence, EPUB and remote request headers", () => {
  it.each(["epub", "txt"])(
    "writes uploaded PNG to %s EPUB and synchronized SQLite metadata",
    (source) => {
      seed(source);
      replaceCover(id, png, "cover.png", library);
      expect(
        extractCover(readFileSync(epubPath(library.base, id)))?.[0],
      ).toEqual(new Uint8Array(png));
      const meta = library.loadMetadata(id);
      expect(meta.cover_file).toBe("cover.png");
      expect(meta.status).toBe("synced");
      expect(meta.epub_updated_at).toBe(meta.updated_at);
      expect(
        readFileSync(coverPath(library.base, id, meta.cover_file!)),
      ).toEqual(png);
    },
  );
  it("rebuilds TXT from source with the selected rule and saves book.json", () => {
    seed("txt");
    writeFileSync(
      join(bookDir(library.base, id), "source.txt"),
      "示例书\n作者：作者\n第一章 新章节\n内容",
    );
    replaceCover(id, png, "cover.png", library);
    expect(extractCover(readFileSync(epubPath(library.base, id)))?.[0]).toEqual(
      new Uint8Array(png),
    );
    expect(
      readFileSync(join(bookDir(library.base, id), "book.json"), "utf8"),
    ).toContain("新章节");
  });
  it("extracts an embedded EPUB cover and reports missing embedded cover", () => {
    seed();
    expect(() => extractBookCover(id, library)).toThrow("EPUB 中没有封面");
    replaceCover(id, png, "cover.png", library);
    extractBookCover(id, library);
    expect(extractCover(readFileSync(epubPath(library.base, id)))?.[0]).toEqual(
      new Uint8Array(png),
    );
  });
  it("returns missing EPUB without marking metadata as synced", () => {
    const meta = seed();
    rmSync(epubPath(library.base, id));
    expect(() => writeBookEpub(meta, library)).toThrow("EPUB 不存在");
  });
  it.each([
    "https://img3.doubanio.com/view/subject/l/public/s7654321.jpg",
    "https://book.douban.com/cover.png",
    "https://doubanio.com/cover.png",
  ])("sets Douban browser headers for %s", async (url) => {
    const fake = vi.fn<Fetch>(async () => new Response(png));
    const result = await downloadCoverFromUrl(url, fake);
    expect(result.data).toEqual(png);
    const headers = new Headers(fake.mock.calls[0][1]?.headers);
    expect(headers.get("Referer")).toBe("https://book.douban.com/");
    expect(headers.get("User-Agent")).toBe(USER_AGENT);
    expect(headers.get("Cache-Control")).toBe("no-cache");
    expect(headers.get("Pragma")).toBe("no-cache");
    expect(headers.get("Accept-Language")).toBe("zh-CN,zh;q=0.9,en;q=0.8");
    expect(result.filename).toBe(url.split("/").at(-1));
  });
  it.each([
    "https://example.com/assets/cover.jpg",
    "https://evil-douban.com/cover.jpg",
    "https://doubanio.com.example.com/cover.jpg",
  ])("keeps other hosts free of Douban headers: %s", async (url) => {
    const fake = vi.fn<Fetch>(async () => new Response(png));
    await downloadCoverFromUrl(url, fake);
    expect(Object.keys(fake.mock.calls[0][1]?.headers || {})).toEqual([]);
  });
  it("keeps legacy remote error messages for HTTP, network and empty bodies", async () => {
    await expect(
      downloadCoverFromUrl(
        "https://img.doubanio.com/one.jpg",
        async () => new Response(null, { status: 403 }),
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: "豆瓣封面下载失败（HTTP 403）: https://img.doubanio.com/one.jpg",
    });
    await expect(
      downloadCoverFromUrl("https://example.com/one.jpg", async () => {
        throw new Error("blocked");
      }),
    ).rejects.toThrow("封面下载失败（网络异常）: blocked");
    await expect(
      downloadCoverFromUrl(
        "https://example.com/one.jpg",
        async () => new Response(),
      ),
    ).rejects.toThrow("封面 URL 下载为空");
  });
  it.each(["", "not a URL", "file:///etc/passwd", "data:image/png,x"])(
    "rejects invalid cover URL %s before fetch",
    async (raw) => {
      const fake = vi.fn<Fetch>();
      await expect(downloadCoverFromUrl(raw, fake)).rejects.toMatchObject({
        status: 400,
      });
      expect(fake).not.toHaveBeenCalled();
    },
  );
  it("limits declared and streamed remote content lengths", async () => {
    await expect(
      downloadCoverFromUrl(
        "https://example.com/a",
        async () =>
          new Response(png, {
            headers: { "Content-Length": String(MAX_COVER_BYTES + 1) },
          }),
      ),
    ).rejects.toMatchObject({ status: 413 });
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(MAX_COVER_BYTES + 1));
      },
      cancel() {
        canceled = true;
      },
    });
    await expect(
      downloadCoverFromUrl(
        "https://example.com/a",
        async () => new Response(stream),
      ),
    ).rejects.toMatchObject({ status: 413 });
    expect(canceled).toBe(true);
  });
  it("rejects empty, overlarge and unsupported cover content", async () => {
    expect(() => validateCover(new Uint8Array())).toThrow("Empty cover");
    expect(() => validateCover(new Uint8Array(MAX_COVER_BYTES + 1))).toThrow(
      "封面文件过大",
    );
    expect(() =>
      validateCover(Buffer.from("<html>not a cover</html>")),
    ).toThrow("不支持的封面类型");
    await expect(
      uploadedCover(new File([new Uint8Array(MAX_COVER_BYTES + 1)], "big.png")),
    ).rejects.toMatchObject({ status: 413 });
  });
  it.each([
    Buffer.from([255, 216, 255, 0]),
    Buffer.from("GIF87a"),
    Buffer.from("RIFFxxxxWEBP"),
    Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
  ])("accepts supported image signature %j", (data) => {
    expect(() => validateCover(data)).not.toThrow();
  });
});
describe("archive, restore, deletion and route boundary", () => {
  it("moves archive files, restores them and permanently deletes book metadata only", () => {
    seed();
    setReadStatus(id, "1", library);
    archiveBook(id, library);
    expect(existsSync(archiveBookDir(library.base, id))).toBe(true);
    expect(library.loadMetadata(id).archived).toBe(true);
    expect(() => loadBookPage(id, "/", library)).toThrow("书籍不存在");
    restoreBook(id, library);
    expect(library.loadMetadata(id).archived).toBe(false);
    expect(existsSync(epubPath(library.base, id))).toBe(true);
    deleteBook(id, library);
    expect(
      library.db.get("SELECT 1 FROM books WHERE book_id=?", id),
    ).toBeNull();
    expect(library.db.getWishByLibraryBookId(id)).toBeTruthy();
    expect(existsSync(bookDir(library.base, id))).toBe(false);
    deleteBook(id, library);
  });
  it("deletes archived data and rejects invalid IDs and restore collisions", () => {
    seed();
    archiveBook(id, library);
    mkdirSync(bookDir(library.base, id));
    expect(() => restoreBook(id, library)).toThrow("Book exists");
    rmSync(bookDir(library.base, id), { recursive: true });
    deleteBook(id, library);
    expect(existsSync(archiveBookDir(library.base, id))).toBe(false);
    expect(() => restoreBook(id, library)).toThrow("Book not found");
    for (const invalid of ["../x", "INVALID", "a".repeat(31)]) {
      expect(() => deleteBook(invalid, library)).toThrow("书籍不存在");
      expect(() => restoreBook(invalid, library)).toThrow("书籍不存在");
    }
  });
  it("authenticates before invoking mutations and returns Chinese business errors", async () => {
    seed();
    const handler = authenticatedRoute<{ book_id: string }>(
      ({ params, library }) => {
        setReadStatus(params.book_id, "1", library);
        return Response.json({ ok: true });
      },
      () => library,
    );
    const anonymous = await handler({
      request: new Request("http://local/book/x/read"),
      params: { book_id: id },
    });
    expect(anonymous.status).toBe(303);
    expect(library.loadMetadata(id).read).toBe(false);
    const cookie = `bindery_session=${signIn(library.db)}`;
    const missing = await handler({
      request: new Request("http://local/book/x/read", {
        headers: { Cookie: cookie },
      }),
      params: { book_id: "invalid" },
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ detail: "书籍不存在" });
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
  });
});
describe("return navigation", () => {
  it.each([
    "/?sort=updated&page=2&read_filter=unread",
    "/book/x",
    "/archive?q=书",
  ])("retains internal path %s", (value) => {
    expect(safeInternalTarget(value, "/fallback")).toBe(value);
  });
  it.each([
    "https://evil.example/x",
    "//evil.example/x",
    "relative",
    "/\\evil.example/x",
    "",
  ])("rejects unsafe target %s", (value) => {
    expect(safeInternalTarget(value, "/fallback")).toBe("/fallback");
  });
  it("drops fragments and path params and encodes return_to once", () => {
    expect(safeInternalTarget(" /book/x;params?q=1#fragment ")).toBe(
      "/book/x?q=1",
    );
    expect(bookNavigation(id, "/?q=!'()*").return_to_query).toBe(
      "?return_to=%2F%3Fq%3D%21%27%28%29%2A",
    );
    expect(bookNavigation(id, "/").return_to_query).toBe("");
    expect(
      new URL(
        bookNavigation(id, "/?q=书&page=2").edit_url,
        "http://local",
      ).searchParams.get("return_to"),
    ).toBe("/?q=书&page=2");
  });
});
describe("SQLite metadata compatibility", () => {
  it("migrates active and archived legacy metadata and removes legacy files", () => {
    const active = "b".repeat(32),
      archived = "c".repeat(32),
      activeDir = bookDir(library.base, active),
      archivedDir = archiveBookDir(library.base, archived);
    mkdirSync(activeDir, { recursive: true });
    mkdirSync(archivedDir, { recursive: true });
    writeFileSync(join(activeDir, "book.json"), "{}");
    writeFileSync(
      join(activeDir, "meta.json"),
      JSON.stringify(
        metadataFromDict({
          book_id: active,
          title: "Legacy Active",
          author: "A",
        }),
      ),
    );
    writeFileSync(
      join(archivedDir, "meta.json"),
      JSON.stringify(
        metadataFromDict({
          book_id: archived,
          title: "Legacy Archived",
          author: "B",
          archived: true,
        }),
      ),
    );
    // loadMetadata also supports legacy files appearing after initial library initialization.
    expect(library.loadMetadata(active).title).toBe("Legacy Active");
    expect(library.loadMetadata(archived).archived).toBe(true);
    expect(library.listBooks().map((m) => m.book_id)).toEqual([active]);
    expect(library.listArchivedBooks().map((m) => m.book_id)).toEqual([
      archived,
    ]);
    expect(existsSync(join(activeDir, "meta.json"))).toBe(false);
    expect(existsSync(join(archivedDir, "meta.json"))).toBe(false);
    expect(
      library.db.all("SELECT book_id,archived FROM books ORDER BY book_id"),
    ).toEqual([
      { book_id: active, archived: 0 },
      { book_id: archived, archived: 1 },
    ]);
  });
});
