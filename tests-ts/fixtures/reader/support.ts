import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { metadataFromDict, type Metadata } from "../../../src/core/models";
import { parseBook } from "../../../src/core/parsing";
import { buildEpub } from "../../../src/core/epub";
import { BinderyDatabase } from "../../../src/server/db";
import { LibraryStorage, saveBook, epubPath } from "../../../src/server/storage";
export function readerFixture(extra: Partial<Metadata> = {}) {
  const root = mkdtempSync(join(tmpdir(), "bindery-reader-"));
  const library = new LibraryStorage(join(root, "library"), new BinderyDatabase(join(root, "db.sqlite")));
  library.ensure();
  const id = "d".repeat(32);
  const meta = metadataFromDict({ book_id: id, title: "测试书", author: "作者", source_type: "epub", theme_template: "__book__", ...extra });
  library.saveMetadata(meta);
  const book = parseBook("第一章 开篇\nalpha beta gamma\n第二章 重逢\nkeyword beta there\n第三章 再见\nno match", "reader");
  saveBook(book, library.base, id);
  writeFileSync(epubPath(library.base, id), buildEpub(book, meta, { css_text: "" }));
  return { root, library, id, meta, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
export const readerRequest = (path = "/", init: RequestInit = {}) => new Request("http://localhost" + path, init);
