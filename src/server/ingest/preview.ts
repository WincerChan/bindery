import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { LibraryStorage } from "../storage";
import { listEpubSections, extractEpubMetadata } from "../../core/epub";
import { getRule } from "../templates";
import { parseBookFileEvents, textFileHasContent } from "../parsing";
import { cleanupStagedExcept, cleanupStaged, stageUpload, type UploadFile } from "./staging";
import { duplicateBooks, resolveTxtIdentity, safeFilename } from "./identity";
export interface Preview {
  filename: string; format: string; title: string | null; author: string | null; volumes: number; chapters: number; toc: string[]; output: string; error?: string; duplicates: ReturnType<typeof duplicateBooks>; upload_token: string | null;
}
export async function previewUploads(library: LibraryStorage, files: UploadFile[], ruleId = "default"): Promise<Preview[]> {
  cleanupStagedExcept(library);
  const previews: Preview[] = [];
  for (const file of files) {
    const entry = await stageUpload(library, file), name = basename(entry.filename, extname(entry.filename));
    const item: Preview = { filename: entry.filename, format: entry.kind === "txt" ? "TXT" : entry.kind === "epub" ? "EPUB" : "未知", title: null, author: null, volumes: 0, chapters: 0, toc: [], output: "—", duplicates: [], upload_token: entry.token };
    previews.push(item);
    if (!entry.size) { item.format = "未知"; item.error = "空文件"; item.upload_token = null; cleanupStaged(library, entry.token); continue; }
    if (entry.kind === "epub") {
      item.output = entry.filename;
      try {
        const data = readFileSync(entry.payload_path), meta = extractEpubMetadata(data, name), sections = listEpubSections(data);
        item.title = meta.title; item.author = meta.author; item.chapters = sections.length; item.toc = sections.slice(0, 10).map(s => s.title); item.duplicates = duplicateBooks(library, meta.title, meta.author, meta.isbn);
      } catch { item.error = "解析 EPUB 失败"; }
    } else if (entry.kind === "txt") {
      if (!textFileHasContent(entry.payload_path)) { item.error = "文本为空或无法解码"; continue; }
      for (const event of parseBookFileEvents(entry.payload_path, name, getRule(ruleId)?.rules)) {
        if ("intro" in event) [item.title, item.author] = resolveTxtIdentity(name, event.title, event.author);
        else { if (event.kind === "volume") item.volumes++; else if (event.kind === "chapter") item.chapters++; if (item.toc.length < 10) item.toc.push(event.title); }
      }
      item.output = safeFilename(item.title || name) + ".epub"; item.duplicates = duplicateBooks(library, item.title, item.author, null);
    } else item.error = "不支持的文件类型（仅支持 .txt / .epub）";
  }
  return previews;
}
