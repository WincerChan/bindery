import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metadataFromDict, type Metadata } from "../../../src/core/models";
import { parseBook } from "../../../src/core/parsing";
import { buildEpub } from "../../../src/core/epub";
import { BinderyDatabase } from "../../../src/server/db";
import { LibraryStorage, epubPath, saveBook, sourcePath } from "../../../src/server/storage";

export function temporaryLibrary() {
  const root = mkdtempSync(join(tmpdir(), "bindery-library-"));
  const library = new LibraryStorage(join(root, "library"), new BinderyDatabase(join(root, "library", "bindery.db")));
  library.ensure();
  return { root, library };
}
export function createBook(library: LibraryStorage, id: string, extra: Partial<Metadata> = {}, source = false) {
  const meta = metadataFromDict({ book_id: id, title: "同名书", author: "作者", created_at: "2026-01-01T00:00:00+00:00", updated_at: "2026-01-02T00:00:00+00:00", ...extra });
  library.saveMetadata(meta);
  const text = "书名：同名书\n作者：作者\n第一章 开篇\n正文。";
  const book = parseBook(text, id);
  saveBook(book, library.base, id);
  writeFileSync(epubPath(library.base, id), buildEpub(book, meta));
  if (source) writeFileSync(sourcePath(library.base, id), text);
  return meta;
}
