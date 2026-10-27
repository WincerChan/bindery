import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Book, BookData, Metadata } from "../core/models";
import { bookFromDict, bookToDict, metadataFromDict } from "../core/models";
import { strip } from "../core/text";
import { BinderyDatabase, nowIso } from "./db";
import { compatJson, readTags } from "./db/encoding";
import type { Row, Value } from "./db/connection";
import { libraryPath } from "./paths";
export const META_FILE = "meta.json",
  BOOK_FILE = "book.json",
  SOURCE_FILE = "source.txt",
  EPUB_FILE = "book.epub",
  COVER_PREFIX = "cover";
export const BOOK_COLUMNS = ["book_id", "title", "author", "language", "description", "source_type", "series", "identifier", "publisher", "tags_json", "published", "isbn", "rating", "status", "epub_updated_at", "archived", "read", "read_updated_at", "cover_file", "rule_template", "theme_template", "custom_css", "created_at", "updated_at"] as const;
export interface TemplateUsage { book_count: number; archived_count: number }
const initialized = new Set<string>();
export function newBookId(): string {
  return randomUUID().replaceAll("-", "");
}
export function libraryDir(): string {
  const base = libraryPath();
  mkdirSync(base, {
    recursive: true
  });
  return base;
}
export function bookDir(base: string, id: string): string {
  if (!id || id === "." || id === ".." || /[\/\\\0]/.test(id)) throw new Error("Invalid book ID");
  return join(base, id);
}
export function archiveDir(base: string): string {
  const path = join(base, "archive");
  mkdirSync(path, {
    recursive: true
  });
  return path;
}
export function archiveBookDir(base: string, id: string): string {
  return bookDir(archiveDir(base), id);
}
export function epubPath(base: string, id: string): string {
  return join(bookDir(base, id), EPUB_FILE);
}
export function sourcePath(base: string, id: string): string {
  return join(bookDir(base, id), SOURCE_FILE);
}
export function coverPath(base: string, id: string, filename: string): string {
  if (filename !== filename.split(/[\/\\]/).at(-1) || filename === "..") throw new Error("Invalid cover filename");
  return join(bookDir(base, id), filename);
}
function isDir(path: string): boolean {
  return statSync(path, {
    throwIfNoEntry: false
  })?.isDirectory() ?? false;
}
function removeMeta(path: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
function readJson(path: string): unknown {
  return JSON.parse(new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true
  }).decode(readFileSync(path)));
}
function legacyMetadata(data: unknown): Metadata {
  const meta = metadataFromDict(data as Partial<Metadata>);
  meta.archived = Boolean(meta.archived);
  meta.read = Boolean(meta.read);
  return meta;
}
function metadataValues(meta: Metadata): Value[] {
  const row = {
    ...meta,
    title: meta.title || "",
    language: meta.language || "zh-CN",
    source_type: meta.source_type || "txt",
    status: meta.status || "synced",
    created_at: meta.created_at || "",
    updated_at: meta.updated_at || "",
    tags_json: compatJson(meta.tags),
    archived: Number(Boolean(meta.archived)),
    read: Number(Boolean(meta.read))
  };
  return BOOK_COLUMNS.map(column => row[column]);
}
function rowToMetadata(row: Row): Metadata {
  const {
    tags_json,
    // Derived EPUB cache is DB-only, never part of Metadata or its exports.
    word_count,
    word_count_key,
    ...rest
  } = row;
  const meta = rest as unknown as Metadata;
  return {
    ...meta,
    title: meta.title || "",
    language: meta.language || "zh-CN",
    source_type: meta.source_type || "txt",
    status: meta.status || "synced",
    created_at: meta.created_at || "",
    updated_at: meta.updated_at || "",
    tags: readTags(tags_json),
    archived: Boolean(meta.archived),
    read: Boolean(meta.read)
  };
}
const ORDER_UPDATED = "CASE WHEN updated_at IS NULL OR updated_at = '' THEN created_at ELSE updated_at END DESC";
const UPSERT = `INSERT INTO books (${BOOK_COLUMNS.join(", ")}) VALUES (${BOOK_COLUMNS.map(() => "?").join(", ")}) ON CONFLICT(book_id) DO UPDATE SET ${BOOK_COLUMNS.slice(1).map(c => `${c}=excluded.${c}`).join(", ")}`;
export function saveBook(book: Book, base: string, id: string): void {
  const path = bookDir(base, id);
  mkdirSync(path, {
    recursive: true
  });
  writeFileSync(join(path, BOOK_FILE), compatJson(bookToDict(book), 2), "utf8");
}
export function loadBook(base: string, id: string): Book {
  return bookFromDict(readJson(join(bookDir(base, id), BOOK_FILE)) as BookData);
}
export function writeSourceFile(base: string, id: string, src: string): void {
  const path = bookDir(base, id);
  mkdirSync(path, {
    recursive: true
  });
  copyFileSync(src, join(path, SOURCE_FILE));
}
export function saveCoverBytes(base: string, id: string, data: Uint8Array, filename: string | null = null): string {
  let ext = extname(filename || "").toLowerCase();
  if (ext === ".") ext = "";
  const bytes = Buffer.from(data);
  if (!ext) {
    if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) ext = ".jpg";else if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) ext = ".png";else if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())) ext = ".gif";else if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") ext = ".webp";else if (bytes.toString("latin1").replace(/^[\t\n\v\f\r ]+/, "").slice(0, 64).toLowerCase().includes("<svg")) ext = ".svg";
  }
  const name = `${COVER_PREFIX}${ext || ".jpg"}`;
  writeFileSync(coverPath(base, id, name), data);
  return name;
}
export class LibraryStorage {
  constructor(readonly base = libraryPath(), readonly db = new BinderyDatabase()) {}
  ensure(): void {
    const key = resolve(this.db.path);
    if (initialized.has(key)) return;
    this.db.init();
    const candidates: [string, boolean][] = [];
    if (existsSync(this.base)) for (const name of readdirSync(this.base)) {
      const path = join(this.base, name);
      if (name !== "archive" && isDir(path)) candidates.push([join(path, META_FILE), false]);
    }
    for (const name of readdirSync(archiveDir(this.base))) {
      const path = join(this.base, "archive", name);
      if (isDir(path)) candidates.push([join(path, META_FILE), true]);
    }
    for (const [path, archived] of candidates) {
      if (!existsSync(path)) continue;
      let meta: Metadata;
      try {
        meta = legacyMetadata(readJson(path));
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof Error && "code" in error) continue;
        throw error;
      }
      meta.book_id ||= path.split(/[\/\\]/).at(-2)!;
      if (this.db.get("SELECT 1 FROM books WHERE book_id = ?", meta.book_id)) {
        removeMeta(path);
        continue;
      }
      meta.archived = Boolean(meta.archived || archived);
      this.db.run(UPSERT, ...metadataValues(meta));
      removeMeta(path);
    }
    initialized.add(key);
  }
  saveMetadata(meta: Metadata): void {
    this.ensure();
    mkdirSync(meta.archived ? archiveBookDir(this.base, meta.book_id) : bookDir(this.base, meta.book_id), {
      recursive: true
    });
    this.db.run(UPSERT, ...metadataValues(meta));
    removeMeta(join(bookDir(this.base, meta.book_id), META_FILE));
    removeMeta(join(archiveBookDir(this.base, meta.book_id), META_FILE));
  }
  loadMetadata(id: string): Metadata {
    this.ensure();
    const row = this.db.get("SELECT * FROM books WHERE book_id = ?", id);
    if (row) return rowToMetadata(row);
    for (const [path, archived] of [[join(bookDir(this.base, id), META_FILE), false], [join(archiveBookDir(this.base, id), META_FILE), true]] as const) {
      if (!existsSync(path)) continue;
      const meta = legacyMetadata(readJson(path));
      meta.book_id ||= id;
      meta.archived = Boolean(meta.archived || archived);
      this.saveMetadata(meta);
      return meta;
    }
    throw Object.assign(new Error(`Metadata not found for book ${id}`), {
      code: "ENOENT"
    });
  }
  listBooks(sortOutput = true): Metadata[] {
    this.ensure();
    return this.db.all(`SELECT * FROM books WHERE archived = 0 ${sortOutput ? `ORDER BY ${ORDER_UPDATED}` : ""}`).map(rowToMetadata).filter(m => isDir(bookDir(this.base, m.book_id)));
  }
  templateUsage(kind: "rules" | "themes"): Map<string, TemplateUsage> {
    this.ensure();
    const column = kind === "rules" ? "rule_template" : "theme_template";
    const rows = this.db.all<{ book_id: string; archived: number; template_id: string | null }>(`
      SELECT book_id, archived, ${column} AS template_id FROM books
      WHERE archived IN (0, 1) ${kind === "rules" ? "AND source_type != 'epub'" : ""}`);
    const usage = new Map<string, TemplateUsage>();
    for (const row of rows) {
      // Match listBooks/listArchivedBooks (also used by deleteTemplate), not
      // just DB rows or ensureBookExists, which additionally requires book assets.
      if (!isDir(row.archived ? archiveBookDir(this.base, row.book_id) : bookDir(this.base, row.book_id))) continue;
      // Match deleteTemplate's Unicode strip; blank references use the default.
      const id = strip(row.template_id || "") || "default";
      if (kind === "themes" && id === "__book__") continue;
      const current = usage.get(id) ?? { book_count: 0, archived_count: 0 };
      current.book_count++;
      current.archived_count += row.archived;
      usage.set(id, current);
    }
    return usage;
  }
  seedWishlistFromBooks(): void {
    this.db.run(`INSERT INTO wishlist(id, title, library_book_id, author, rating, read, read_status, tags_json, comment, book_status, created_at, updated_at)
      SELECT lower(hex(randomblob(16))), coalesce(nullif(trim(b.title), ''), '未命名'), b.book_id, b.author, b.rating, b.read,
      CASE WHEN b.read = 1 THEN 'read' ELSE 'unread' END, '[]', NULL, 'completed',
      CASE WHEN b.created_at IS NULL OR b.created_at = '' THEN coalesce(b.updated_at, '') ELSE b.created_at END,
      CASE WHEN b.updated_at IS NULL OR b.updated_at = '' THEN coalesce(b.created_at, '') ELSE b.updated_at END
      FROM books AS b LEFT JOIN wishlist AS w ON w.library_book_id = b.book_id WHERE w.library_book_id IS NULL`);
  }
  listBooksPage({
    scope = "active",
    sort = "updated",
    q = "",
    read_filter = "all",
    page = 1,
    per_page = 24
  } = {}): [Metadata[], number] {
    this.ensure();
    const archived = scope === "archived", unread = !archived && strip(read_filter || "").toLowerCase() === "unread";
    const query = strip(q || "").toLowerCase(),
      conditions = [archived ? "b.archived = 1" : "b.archived = 0"],
      params: Value[] = [];
    if (query) {
      conditions.push("(lower(b.title) LIKE ? OR lower(coalesce(b.author, '')) LIKE ?)");
      params.push(`%${query}%`, `%${query}%`);
    }
    if (unread) {
      conditions.push("coalesce(w.read_status, 'unread') != 'read'");
      this.seedWishlistFromBooks();
    }
    const where = `FROM books AS b LEFT JOIN wishlist AS w ON w.library_book_id = b.book_id WHERE ${conditions.join(" AND ")}`;
    const order = strip(sort || "").toLowerCase() === "created" ? "b.created_at DESC" : "CASE WHEN b.updated_at IS NULL OR b.updated_at = '' THEN b.created_at ELSE b.updated_at END DESC";
    const size = Math.max(1, Math.trunc(per_page)), offset = (Math.max(1, Math.trunc(page)) - 1) * size;
    if (archived) {
      const books = this.db.all(`SELECT b.* ${where} ORDER BY ${order}`, ...params).map(rowToMetadata).filter(m => isDir(archiveBookDir(this.base, m.book_id)));
      return [books.slice(offset, offset + size), books.length];
    }
    const total = this.db.get<{
      count: number;
    }>(`SELECT COUNT(1) AS count ${where}`, ...params)!.count;
    const books = this.db.all(`SELECT b.* ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, size, (Math.max(1, Math.trunc(page)) - 1) * size);
    return [books.map(rowToMetadata).filter(m => isDir(bookDir(this.base, m.book_id))), total];
  }
  listArchivedBooks(): Metadata[] {
    this.ensure();
    return this.db.all(`SELECT * FROM books WHERE archived = 1 ORDER BY ${ORDER_UPDATED}`).map(rowToMetadata).filter(m => isDir(archiveBookDir(this.base, m.book_id)));
  }
  ensureBookExists(id: string): boolean {
    let meta: Metadata;
    try {
      meta = this.loadMetadata(id);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
    const path = bookDir(this.base, id);
    return !meta.archived && isDir(path) && (existsSync(join(path, BOOK_FILE)) || existsSync(join(path, EPUB_FILE)));
  }
  deleteBook(id: string): void {
    let path = bookDir(this.base, id);
    if (!existsSync(path)) path = archiveBookDir(this.base, id);
    if (existsSync(path)) rmSync(path, {
      recursive: true
    });
    this.ensure();
    this.db.run("DELETE FROM books WHERE book_id = ?", id);
  }
  archiveBook(id: string): void {
    const src = bookDir(this.base, id);
    if (existsSync(src)) {
      const dest = archiveBookDir(this.base, id);
      if (existsSync(dest)) rmSync(dest, {
        recursive: true
      });
      try {
        renameSync(src, dest);
      } catch {
        // shutil.move falls back to copying across filesystems before removing
        // the source. Keep the source intact if the copy fails.
        cpSync(src, dest, {
          recursive: true,
          preserveTimestamps: true,
          verbatimSymlinks: true
        });
        rmSync(src, {
          recursive: true
        });
      }
    }
    this.ensure();
    this.db.run("UPDATE books SET archived = ? WHERE book_id = ?", 1, id);
  }
  // the legacy implementation's restore_view: preserve files, reject destination collisions, update timestamp.
  restoreBook(id: string, updatedAt = nowIso()): void {
    const src = archiveBookDir(this.base, id),
      dest = bookDir(this.base, id);
    if (!existsSync(src)) throw Object.assign(new Error("Book not found"), {
      status: 404
    });
    if (existsSync(dest)) throw Object.assign(new Error("Book exists"), {
      status: 409
    });
    renameSync(src, dest);
    const meta = this.loadMetadata(id);
    meta.archived = false;
    meta.updated_at = updatedAt;
    this.saveMetadata(meta);
  }
}
