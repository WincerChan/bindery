import { existsSync, statSync } from "node:fs";
import type { Metadata, Wish } from "../core/models";
import { strip } from "../core/python";
import { bookDir, coverPath, sourcePath } from "./storage";
import { getLibrary } from "./runtime";

export function effectiveThemeId(meta: Metadata): string | null {
  const id = strip(meta.theme_template || "");
  return meta.source_type === "epub" && id === "__book__" ? null : id || "default";
}

export function statusView(meta: Metadata): { status_label: string; status_class: "failed" | "pending" | "ok" } {
  if (meta.status === "failed") return { status_label: "转换失败", status_class: "failed" };
  if (meta.status !== "dirty" && meta.epub_updated_at && meta.updated_at && meta.epub_updated_at >= meta.updated_at) {
    return { status_label: "已写回元数据", status_class: "ok" };
  }
  return { status_label: "待写回", status_class: "pending" };
}

export function bookView(meta: Metadata, library = getLibrary(), tracker?: Wish | null) {
  const wish = tracker ?? (!meta.archived ? library.db.getWishByLibraryBookId(meta.book_id) : null);
  const source_type = meta.source_type || "txt";
  let cover_url: string | null = null;
  if (meta.cover_file && !meta.archived) {
    const path = coverPath(library.base, meta.book_id, meta.cover_file);
    const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
    const version = stat ? String(stat.mtimeNs) : meta.updated_at || "";
    cover_url = `/book/${meta.book_id}/cover${version ? `?${new URLSearchParams({ v: version })}` : ""}`;
  }
  return {
    ...meta,
    tags: [...meta.tags],
    ...statusView(meta),
    source_type,
    effective_theme_template: effectiveThemeId(meta),
    can_regenerate: source_type !== "epub" && existsSync(sourcePath(library.base, meta.book_id)),
    read: wish ? strip(wish.read_status || (wish.read ? "read" : "unread")).toLowerCase() === "read" : meta.read,
    rating: wish ? wish.rating : meta.rating,
    path: bookDir(library.base, meta.book_id),
    cover_url,
  };
}
export type BookView = ReturnType<typeof bookView>;
