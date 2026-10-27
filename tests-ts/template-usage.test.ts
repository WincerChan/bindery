import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { metadataFromDict } from "../src/core/models";
import { BinderyDatabase } from "../src/server/db";
import { archiveBookDir, bookDir, LibraryStorage } from "../src/server/storage";
import { templateDirectory } from "../src/server/templates";
import { catalogPage, deleteTemplate, newTemplate } from "../src/server/catalog/templates";

let root: string, library: LibraryStorage;
const kinds = ["rules", "themes"] as const;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bindery-template-usage-"));
  for (const name of ["BINDERY_RULES_DIR", "BINDERY_THEMES_DIR", "BINDERY_TEMPLATE_DIR"]) { vi.stubEnv(name, ""); vi.stubEnv(`${name}_FILE`, ""); }
  vi.stubEnv("BINDERY_TEMPLATE_DIR", join(root, "templates"));
  library = new LibraryStorage(join(root, "library"), new BinderyDatabase(join(root, "data.db"))); library.ensure();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function templates(...ids: string[]) {
  for (const kind of kinds) {
    for (const id of ids) writeFileSync(join(templateDirectory(kind), `${id}.json`), JSON.stringify({ id, name: id }));
  }
}
const counts = (items: ReturnType<typeof catalogPage>["rules"]) => items.map(({ id, book_count, archived_count }) => ({ id, book_count, archived_count }));
const pathFor = (id: string, archived: boolean) => archived ? archiveBookDir(library.base, id) : bookDir(library.base, id);

describe("template usage and catalog counts", () => {
  it("returns zero usage for templates in an empty library", () => {
    const page = catalogPage({}, library);
    for (const kind of kinds) {
      expect(library.templateUsage(kind).size).toBe(0);
      expect(counts(page[kind])).toEqual([{ id: "default", book_count: 0, archived_count: 0 }]);
    }
  });
  it.each([null, "", " \t\r\n", "\u0085\u3000"])("resolves blank reference %j to default, not the first template", reference => {
    templates("alpha");
    library.saveMetadata(metadataFromDict({ book_id: "blank", title: "空引用", rule_template: reference, theme_template: reference }));
    const page = catalogPage({}, library);
    for (const kind of kinds) {
      expect([...library.templateUsage(kind)]).toEqual([["default", { book_count: 1, archived_count: 0 }]]);
      expect(counts(page[kind])).toEqual([
        { id: "alpha", book_count: 0, archived_count: 0 },
        { id: "default", book_count: 1, archived_count: 0 },
      ]);
    }
  });
  it("does not assign unknown IDs to default or another loaded template", () => {
    templates("alpha");
    library.saveMetadata(metadataFromDict({ book_id: "unknown", title: "未知引用", rule_template: "missing", theme_template: "missing", archived: true }));
    const page = catalogPage({}, library);
    for (const kind of kinds) {
      expect([...library.templateUsage(kind)]).toEqual([["missing", { book_count: 1, archived_count: 1 }]]);
      expect(counts(page[kind])).toEqual([
        { id: "alpha", book_count: 0, archived_count: 0 },
        { id: "default", book_count: 0, archived_count: 0 },
      ]);
      expect(deleteTemplate(kind, "alpha", library)).not.toContain("error");
    }
  });
  it("aggregates active and archived usage with exactly one SQL query per kind", () => {
    templates("alpha", "unused");
    const books = [
      [null, null, "txt", false],
      ["", "", "txt", true],
      ["default", "default", "txt", false],
      ["alpha", "alpha", "txt", false],
      ["alpha", "alpha", "txt", true],
      ["alpha", "alpha", "epub", false],
      [null, null, "epub", true],
      ["default", "__book__", "epub", false],
      ["alpha", "__book__", "txt", false],
      ["missing", "missing", "txt", false],
      [null, "\u0085alpha\u3000", "txt", false],
    ] as const;
    books.forEach(([rule_template, theme_template, source_type, archived], i) => {
      library.saveMetadata(metadataFromDict({ book_id: String(i), title: "引用", rule_template, theme_template, source_type, archived }));
    });
    const all = vi.spyOn(library.db, "all"), connections = vi.spyOn(library.db, "withConnection");
    const page = catalogPage({}, library);
    expect(counts(page.rules)).toEqual([
      { id: "alpha", book_count: 3, archived_count: 1 },
      { id: "default", book_count: 4, archived_count: 1 },
      { id: "unused", book_count: 0, archived_count: 0 },
    ]);
    expect(counts(page.themes)).toEqual([
      { id: "alpha", book_count: 4, archived_count: 1 },
      { id: "default", book_count: 4, archived_count: 2 },
      { id: "unused", book_count: 0, archived_count: 0 },
    ]);
    expect(all).toHaveBeenCalledTimes(2);
    expect(connections).toHaveBeenCalledTimes(2);
    for (const [i, column] of ["rule_template", "theme_template"].entries()) {
      expect(all.mock.calls[i][0]).toContain(`SELECT book_id, archived, ${column} AS template_id FROM books`);
    }
  });
  it.each([false, true])("agrees with deletion for trimmed IDs (archived=%s)", archived => {
    templates("alpha");
    library.saveMetadata(metadataFromDict({ book_id: "padded", title: "空白边界", rule_template: "\u0085 alpha \u3000", theme_template: "\u0085 alpha \u3000", archived }));
    const page = catalogPage({}, library);
    for (const kind of kinds) {
      expect([...library.templateUsage(kind)]).toEqual([["alpha", { book_count: 1, archived_count: Number(archived) }]]);
      expect(page[kind].find(template => template.id === "alpha")).toMatchObject({ book_count: 1, archived_count: Number(archived) });
      expect(deleteTemplate(kind, "alpha", library)).toContain("&error=");
      expect(existsSync(join(templateDirectory(kind), "alpha.json"))).toBe(true);
    }
  });
  describe.each([false, true])("existing-book checks (archived=%s)", archived => {
    it.each(["missing", "file", "wrong-scope"])("excludes a %s book directory just like listings and deletion", state => {
      templates("alpha");
      for (const book_id of ["present", "orphan"]) {
        // An empty directory is sufficient: listings do not require book.json/book.epub.
        library.saveMetadata(metadataFromDict({ book_id, title: book_id, rule_template: "alpha", theme_template: "alpha", archived }));
      }
      const orphan = pathFor("orphan", archived);
      rmSync(orphan, { recursive: true });
      if (state === "file") writeFileSync(orphan, "not a directory");
      if (state === "wrong-scope") mkdirSync(pathFor("orphan", !archived), { recursive: true });
      expect(library.listBooks().map(book => book.book_id)).toEqual(archived ? [] : ["present"]);
      expect(library.listArchivedBooks().map(book => book.book_id)).toEqual(archived ? ["present"] : []);
      expect(library.listBooksPage({ scope: archived ? "archived" : "active" })[0].map(book => book.book_id)).toEqual(["present"]);
      const page = catalogPage({}, library);
      for (const kind of kinds) {
        expect([...library.templateUsage(kind)]).toEqual([["alpha", { book_count: 1, archived_count: Number(archived) }]]);
        expect(page[kind].find(template => template.id === "alpha")).toMatchObject({ book_count: 1, archived_count: Number(archived) });
        expect(deleteTemplate(kind, "alpha", library)).toContain("&error=");
        expect(existsSync(join(templateDirectory(kind), "alpha.json"))).toBe(true);
      }
      rmSync(pathFor("present", archived), { recursive: true });
      expect(library.listBooks()).toEqual([]);
      expect(library.listArchivedBooks()).toEqual([]);
      const empty = catalogPage({}, library);
      for (const kind of kinds) {
        expect(library.templateUsage(kind).size).toBe(0);
        expect(empty[kind].find(template => template.id === "alpha")).toMatchObject({ book_count: 0, archived_count: 0 });
        expect(deleteTemplate(kind, "alpha", library)).not.toContain("error");
        expect(existsSync(join(templateDirectory(kind), "alpha.json"))).toBe(false);
      }
      expect(library.db.get("SELECT COUNT(*) AS n FROM books")).toEqual({ n: 2 });
    });
  });
  it("still blocks rule deletion for EPUB references even though they do not count as usage", () => {
    const id = new URL(newTemplate("rules"), "http://test").searchParams.get("rule_id")!;
    library.saveMetadata(metadataFromDict({ book_id: "epub", title: "EPUB", source_type: "epub", rule_template: id, archived: true }));
    expect(library.templateUsage("rules").size).toBe(0);
    expect(catalogPage({}, library).rules.find(rule => rule.id === id)).toMatchObject({ book_count: 0, archived_count: 0 });
    expect(deleteTemplate("rules", id, library)).toContain("&error=");
    expect(existsSync(join(templateDirectory("rules"), `${id}.json`))).toBe(true);
    rmSync(archiveBookDir(library.base, "epub"), { recursive: true });
    expect(deleteTemplate("rules", id, library)).not.toContain("error");
    expect(existsSync(join(templateDirectory("rules"), `${id}.json`))).toBe(false);
  });
  it.each(["txt", "epub"])("never counts the keep-book-CSS sentinel as a theme (%s)", source_type => {
    library.saveMetadata(metadataFromDict({ book_id: "sentinel", title: "本书样式", source_type, theme_template: " \u0085__book__\u3000", archived: true }));
    expect(library.templateUsage("themes").size).toBe(0);
    expect(counts(catalogPage({}, library).themes)).toEqual([{ id: "default", book_count: 0, archived_count: 0 }]);
  });
});
