import { statSync } from "node:fs";
import { epubCoverItem, manifestFromOpf } from "../../core/epub";
import { ReaderArchive } from "../reader/archive";
import type { LibraryStorage } from "../storage";
import { loadStaged } from "./staging";

const MAX_COVER_BYTES = 20 * 1024 * 1024;
class CoverArchive extends ReaderArchive {
  override read(path: string): Uint8Array | undefined { return super.read(path, MAX_COVER_BYTES); }
}

/** Resolve only the staged EPUB's declared cover; no arbitrary member/file access. */
export function stagedCoverResponse(request: Request, library: LibraryStorage): Response {
  const headers = {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
  };
  const missing = () => new Response(null, { status: 404, headers });
  try {
    const entry = loadStaged(library, new URL(request.url).searchParams.get("upload_token") || "");
    if (!entry || entry.kind !== "epub") return missing();
    const archive = new CoverArchive(entry.payload_path, statSync(entry.payload_path, { bigint: true }), () => {});
    const [path, root] = archive.opf();
    const cover = epubCoverItem(manifestFromOpf(path, root, archive.resolve.bind(archive)), root);
    if (!cover || !/^image\/(jpeg|png|gif|webp|avif|svg\+xml)$/.test(cover.media_type)) return missing();
    const bytes = archive.read(cover.member_path);
    if (!bytes?.length) return missing();
    return new Response(bytes as BodyInit, { headers: { ...headers, "Content-Type": cover.media_type } });
  } catch { return missing(); }
}
