import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LibraryStorage, saveBook } from "../src/server/storage";
import { BinderyDatabase } from "../src/server/db";
import { metadataFromDict } from "../src/core/models";
import { parseBook } from "../src/core/parsing";
import { duplicateCheck, removeTracker, safeTrackerNext, trackerCsv, trackerPage, trackerUrl, writeTracker } from "../src/server/catalog/tracker";

let root: string, library: LibraryStorage;
const create = (fields: Record<string, string>) => writeTracker(library, fields);
const all = () => library.db.listWishes();
function book(id: string, title: string, author: string | null = null) {
  saveBook(parseBook("第一章 开始\n正文", title), library.base, id);
  library.saveMetadata(metadataFromDict({ book_id: id, title, author }));
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "bindery-catalog-tracker-")); library = new LibraryStorage(join(root, "library"), new BinderyDatabase(join(root, "data.db"))); library.ensure(); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe("tracker CRUD and duplicate identities", () => {
  it("ports create, update and delete including tags, read state and default completion", () => {
    expect(create({ title: "诡秘之主", author: "爱潜水的乌贼", tags: " 克苏鲁, 蒸汽朋克，克苏鲁\nTag,tag", rating: "5", comment: " 前中期节奏很好 ", read_status: "read" })).toBe("/tracker");
    const wish = all()[0]; expect(wish).toMatchObject({ title: "诡秘之主", read: true, read_status: "read", book_status: "completed", rating: 5, comment: "前中期节奏很好", tags: ["克苏鲁", "蒸汽朋克", "Tag"] });
    writeTracker(library, { title: "诡秘之主（重读）", author: wish.author!, tags: "克苏鲁", read_status: "reading", book_status: "hiatus", comment: "主线收束很稳" }, wish.id);
    expect(all()[0]).toMatchObject({ title: "诡秘之主（重读）", read: false, read_status: "reading", rating: null, tags: ["克苏鲁"], comment: "主线收束很稳", book_status: "hiatus" });
    expect(removeTracker(library, wish.id, "")).toBe("/tracker"); expect(all()).toEqual([]);
  });
  it.each([["-2", 0], ["20", 5], ["3.5", null], ["bad", null], ["", null], ["+3", 3]])("normalizes rating %s", (input, rating) => { create({ title: "评分", rating: String(input) }); expect(all()[0].rating).toBe(rating); });
  it("supports legacy read flags and normalizes invalid status fields", () => { create({ title: "旧字段", read: "YES", book_status: "bad" }); expect(all()[0]).toMatchObject({ read_status: "read", read: true, book_status: "ongoing" }); });
  it("rejects empty titles and invalid or missing update IDs", () => {
    expect(() => create({ title: " " })).toThrow("书名不能为空");
    expect(() => writeTracker(library, { title: "x" }, "../x")).toThrow("追踪条目不存在");
    expect(() => writeTracker(library, { title: "x" }, "a".repeat(32))).toThrow("追踪条目不存在");
    expect(() => removeTracker(library, "BAD", "")).toThrow("追踪条目不存在");
    expect(removeTracker(library, "a".repeat(32), "")).toBe("/tracker");
  });
  it("blocks normalized identities but allows the same title by a different author", () => {
    create({ title: "同名：校验", author: "作者甲" }); const original = all()[0];
    expect(create({ title: "同名校验", author: "作者甲", next: "/wishlist?q=x&page=2#fragment" })).toBe(`/tracker?q=x&page=2&duplicate=${original.id}`);
    expect(all()).toHaveLength(1); expect(create({ title: "同名校验", author: "作者乙" })).toBe("/tracker"); expect(all()).toHaveLength(2);
    expect(create({ title: "同名校验" })).toContain("duplicate="); expect(all()).toHaveLength(2);
    expect(duplicateCheck(library, "同名校验", "作者丙").exists).toBe(false);
    expect(duplicateCheck(library, "同名校验", "作者甲")).toMatchObject({ exists: true, rule: "title+author", blocking_matches: [{ id: original.id }] });
  });
  it("provides partial suggestions independently of exact blocking matches", () => {
    create({ title: "这游戏也太真实了", author: "晨星LL" });
    const result = duplicateCheck(library, "游戏", ""); expect(result.exists).toBe(false); expect(result.exact_matches).toEqual([]); expect(result.matches[0].title).toBe("这游戏也太真实了");
    expect(duplicateCheck(library, "", "").matches).toEqual([]);
  });
  it("merges manual identity collisions atomically and keeps the original target ID", () => {
    create({ title: "A书", author: "甲作者" }); create({ title: "B书", author: "乙作者" });
    const a = all().find(w => w.title === "A书")!, b = all().find(w => w.title === "B书")!;
    writeTracker(library, { title: "A书", author: "甲作者", tags: "合并后", rating: "5", comment: "应保留单条", read_status: "read", book_status: "completed" }, b.id);
    expect(all()).toHaveLength(1); expect(all()[0]).toMatchObject({ id: a.id, tags: ["合并后"], rating: 5, read: true, comment: "应保留单条" });
  });
  it("rolls back the target update when deletion in a merge fails", () => {
    create({ title: "A", author: "甲" }); create({ title: "B", author: "乙" }); const b = all().find(w => w.title === "B")!;
    library.db.run("CREATE TRIGGER protect_wish BEFORE DELETE ON wishlist BEGIN SELECT RAISE(ABORT, 'blocked'); END");
    expect(() => writeTracker(library, { title: "A", author: "甲", rating: "5" }, b.id)).toThrow("blocked");
    expect(all()).toHaveLength(2); expect(all().find(w => w.title === "A")?.rating).toBeNull();
  });
  it("uses linked book identity, keeps an existing link, and syncs metadata without changing book.json", () => {
    const id = "c".repeat(32); book(id, "库内原始标题", "库内原始作者"); const raw = readFileSync(join(library.base, id, "book.json"), "utf8");
    create({ title: "忽略", library_book_id: id.toUpperCase(), author: "忽略", rating: "4", read_status: "read" });
    const wish = all()[0]; expect(wish).toMatchObject({ title: "库内原始标题", author: "库内原始作者", library_book_id: id }); expect(library.loadMetadata(id)).toMatchObject({ read: true, rating: 4 });
    writeTracker(library, { title: "仍忽略", library_book_id: "", rating: "5", read_status: "reading" }, wish.id);
    expect(all()[0]).toMatchObject({ title: "库内原始标题", rating: 5, read_status: "reading", library_book_id: id }); expect(library.loadMetadata(id)).toMatchObject({ read: false, rating: 5 });
    expect(readFileSync(join(library.base, id, "book.json"), "utf8")).toBe(raw);
    expect(create({ library_book_id: id })).toContain("duplicate=");
  });
  it("treats missing/invalid/archived library IDs as manual records", () => {
    book("a".repeat(32), "归档"); library.archiveBook("a".repeat(32));
    for (const [i, id] of ["../a", "f".repeat(32), "a".repeat(32)].entries()) create({ title: `手工${i}`, library_book_id: id });
    expect(all().every(w => w.library_book_id === null)).toBe(true);
  });
});
describe("tracker listing, metadata consistency, pagination and export", () => {
  it("seeds books once, reuses a compatible manual record and never reuses it twice", () => {
    const idA = "d".repeat(32), idB = "e".repeat(32); book(idA, "同名无作者测试", "作者甲"); book(idB, "同名无作者测试", "作者乙");
    create({ title: "同名无作者测试", rating: "5", read_status: "read", tags: "保留" }); const id = all()[0].id;
    const scan = vi.spyOn(library.db, "listWishes"); const page = trackerPage(library, {});
    expect(scan).toHaveBeenCalledTimes(2); scan.mockRestore();
    expect(page.stats).toMatchObject({ total: 2, in_library: 2, read: 1 }); expect(new Set(all().map(w => w.library_book_id))).toEqual(new Set([idA, idB]));
    expect(library.db.getWish(id)).toMatchObject({ rating: 5, tags: ["保留"] });
    trackerPage(library, {}); expect(all()).toHaveLength(2);
  });
  it("follows book metadata changes while tracker remains authoritative for reading and rating", () => {
    const id = "a".repeat(32); book(id, "原名", "作者"); trackerPage(library, {}); const wish = all()[0];
    library.db.updateWish(wish.id, { read_status: "read", rating: 5 }); const meta = library.loadMetadata(id); meta.title = "新名"; meta.author = "新作者"; library.saveMetadata(meta);
    const page = trackerPage(library, { duplicate: wish.id });
    expect(page.wishes[0]).toMatchObject({ title: "新名", author: "新作者", read: true, rating: 5 }); expect(page.duplicate_notice?.id).toBe(wish.id);
    expect(library.loadMetadata(id)).toMatchObject({ read: true, rating: 5 });
  });
  it("ports all filters and global statistics and binds matching manual books", () => {
    book("b".repeat(32), "雪中悍刀行", "烽火戏诸侯");
    create({ title: "诡秘之主", author: "爱潜水的乌贼", tags: "克苏鲁,西幻", read_status: "read" });
    create({ title: "雪中悍刀行", author: "烽火戏诸侯", tags: "玄幻,江湖", read_status: "reading", book_status: "ongoing" });
    create({ title: "大道争锋", author: "误道者", tags: "仙侠", book_status: "hiatus" });
    const page = trackerPage(library, { q: "江湖", read_filter: "reading", library_filter: "in", book_status_filter: "ongoing" });
    expect(page.wishes).toHaveLength(1); expect(page.wishes[0].title).toBe("雪中悍刀行"); expect(page.stats).toEqual({ total: 3, filtered: 1, read: 1, reading: 1, unread: 1, in_library: 1, out_library: 2 });
    expect(page.current_url).toBe("/tracker?q=%E6%B1%9F%E6%B9%96&read_filter=reading&library_filter=in&book_status_filter=ongoing");
    expect(trackerPage(library, { library_filter: "not_in_library" }).wishes).toHaveLength(2);
    expect(trackerPage(library, { q: "误道者" }).wishes).toHaveLength(1);
    expect(trackerPage(library, { read_filter: "garbage", library_filter: "garbage" }).wishes).toHaveLength(3);
  });
  it("keeps the real currently-reading preview independent of filters and pages, capped at three", () => {
    for (let i = 0; i < 5; i++) create({ title: `正在读-${i}`, read_status: "reading" });
    for (let i = 0; i < 25; i++) create({ title: `等待读-${i}` });
    const page = trackerPage(library, { q: "等待读", read_filter: "unread", page: "2" });
    expect(page.stats).toMatchObject({ total: 30, reading: 5, unread: 25, filtered: 25 });
    expect(page.wishes).toHaveLength(5);
    expect(page.reading_now).toHaveLength(3);
    expect(page.reading_now.every(wish => wish.read_status === "reading" && wish.title.startsWith("正在读-"))).toBe(true);
    expect(trackerPage(library, { q: "没有结果" }).reading_now).toEqual(page.reading_now);
  });
  it("paginates at 20, clamps pages and exports all filtered rows regardless of page", () => {
    for (let i = 0; i < 25; i++) create({ title: `分页书-${i}` });
    const page = trackerPage(library, { page: "2" }); expect(page.wishes).toHaveLength(5); expect(page).toMatchObject({ page: 2, total_pages: 2, current_url: "/tracker?page=2", export_url: "/tracker/export" });
    expect(trackerPage(library, { page: "99" }).page).toBe(2); expect(trackerPage(library, { page: "-1" }).page).toBe(1);
    expect(trackerCsv(library, { page: "2" }).split("\r\n")).toHaveLength(27);
    expect(trackerUrl({ q: "  三 体 ", library_filter: "in_library" }, 2)).toBe("/tracker?q=%E4%B8%89+%E4%BD%93&library_filter=in&page=2");
  });
  it("exports BOM, header, filters, empty cells and RFC4180 quoting", () => {
    create({ title: '书,"名', author: "作者", rating: "5", comment: '短评\n"引用"', read_status: "reading" }); create({ title: "空列" });
    const csv = trackerCsv(library, { read_filter: "reading" }); expect(csv).toMatch(/^\ufefftitle,author,rating,comment,date\r\n/); expect(csv).toContain('"书,""名",作者,5,"短评\n""引用"""'); expect(csv).not.toContain("空列");
    expect(trackerCsv(library, { q: "空列" })).toContain("空列,,,,");
  });
  it.each(["https://evil.test", "//evil.test", "/\\evil.test", "relative", "\n//evil.test"])("rejects unsafe next targets: %s", value => expect(safeTrackerNext(value)).toBe("/tracker"));
  it("preserves safe next filters, strips fragments, and does not add duplicate flags to external targets", () => {
    const target = "/tracker?read_filter=unread&library_filter=out";
    expect(create({ title: "赤心巡天", next: target })).toBe(target); const wish = all()[0];
    expect(writeTracker(library, { title: wish.title, next: target }, wish.id)).toBe(target);
    expect(create({ title: wish.title, next: "https://evil.test" })).toBe(`/tracker?duplicate=${wish.id}`);
    expect(removeTracker(library, wish.id, target + "#top")).toBe(target);
  });
});
