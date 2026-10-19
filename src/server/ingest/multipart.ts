import { mkdirSync, openAsBlob, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import type { LibraryStorage } from "../storage";
import { newBookId } from "../storage";
import { HttpError } from "../http";

/** Fetch's formData() buffers multipart files. Spool parts with bounded scanning
 * buffers, then expose file-backed Blobs through the existing FormData API. */
export async function uploadForm(request: Request, library: LibraryStorage): Promise<{ form: FormData; cleanup(): void }> {
  const contentType = request.headers.get("Content-Type") || "";
  if (!/^multipart\/form-data(?:;|$)/i.test(contentType)) {
    try { return { form: await request.formData(), cleanup() {} }; }
    catch { throw new HttpError(400, "There was an error parsing the body"); }
  }
  const boundaryValue = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = boundaryValue?.[1] || boundaryValue?.[2];
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary) || !request.body) throw new HttpError(400, "Missing boundary in multipart.");
  const directory = join(library.base, ".ingest-queue", ".requests", newBookId());
  mkdirSync(directory, { recursive: true });
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  const form = new FormData(), first = Buffer.from(`--${boundary}\r\n`), empty = Buffer.from(`--${boundary}--`), delimiter = Buffer.from(`\r\n--${boundary}`), headerEnd = Buffer.from("\r\n\r\n");
  let pending = Buffer.alloc(0), state: "first" | "headers" | "body" | "end" = "first", handle: FileHandle | undefined, name = "", filename: string | undefined, type = "", partPath = "", fields: Buffer[] = [], fieldLength = 0, filesCount = 0, fieldsCount = 0;
  const invalid = () => new HttpError(400, "There was an error parsing the body");
  async function write(bytes: Buffer) {
    if (handle) { let offset = 0; while (offset < bytes.length) { const { bytesWritten } = await handle.write(bytes.subarray(offset)); offset += bytesWritten; } }
    else { fieldLength += bytes.length; if (fieldLength > 1024 * 1024) throw new HttpError(400, "Part exceeded maximum size of 1024KB."); fields.push(Buffer.from(bytes)); }
  }
  async function finish() {
    if (handle) {
      await handle.close(); handle = undefined;
      form.append(name, await openAsBlob(partPath, { type }), filename);
    } else form.append(name, Buffer.concat(fields).toString("utf8"));
    fields = []; fieldLength = 0;
  }
  async function consume() {
    while (true) {
      if (state === "end") { pending = Buffer.alloc(0); return; }
      if (state === "first") {
        if (pending.length < first.length) return;
        if (pending.subarray(0, empty.length).equals(empty)) { state = "end"; pending = Buffer.alloc(0); return; }
        if (!pending.subarray(0, first.length).equals(first)) throw invalid();
        pending = pending.subarray(first.length); state = "headers";
      }
      if (state === "headers") {
        const end = pending.indexOf(headerEnd);
        if (end < 0) { if (pending.length > 16384) throw invalid(); return; }
        const headers = pending.subarray(0, end).toString("utf8"); pending = pending.subarray(end + 4);
        const disposition = /^content-disposition:\s*form-data\s*;(.*)$/im.exec(headers)?.[1];
        if (!disposition) throw invalid();
        const params = new Map<string, string>();
        for (const match of disposition.matchAll(/(?:^|;)\s*([\w*]+)=(?:"((?:\\.|[^"\\])*)"|([^;]*))/g)) params.set(match[1].toLowerCase(), (match[2] ?? match[3]).replace(/\\(.)/g, "$1"));
        name = params.get("name") || ""; filename = params.get("filename");
        if (!name) throw invalid();
        type = /^content-type:\s*([^\r\n]+)/im.exec(headers)?.[1].trim() || "";
        if (filename !== undefined) {
          if (++filesCount > 1000) throw new HttpError(400, "Too many files. Maximum number of files is 1000.");
          partPath = join(directory, String(filesCount)); handle = await open(partPath, "wx");
        } else if (++fieldsCount > 1000) throw new HttpError(400, "Too many fields. Maximum number of fields is 1000.");
        state = "body";
      }
      if (state === "body") {
        let index = pending.indexOf(delimiter);
        while (index >= 0 && pending.length >= index + delimiter.length + 2 && !["--", "\r\n"].includes(pending.subarray(index + delimiter.length, index + delimiter.length + 2).toString())) index = pending.indexOf(delimiter, index + 1);
        if (index < 0) {
          const size = Math.max(0, pending.length - delimiter.length - 2);
          if (size) { await write(pending.subarray(0, size)); pending = Buffer.from(pending.subarray(size)); }
          return;
        }
        if (pending.length < index + delimiter.length + 2) return;
        await write(pending.subarray(0, index)); await finish();
        const suffix = pending.subarray(index + delimiter.length, index + delimiter.length + 2).toString(); pending = pending.subarray(index + delimiter.length + 2);
        state = suffix === "--" ? "end" : "headers";
      }
    }
  }
  const reader = request.body.getReader();
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; pending = Buffer.concat([pending, Buffer.from(value)]); await consume(); }
    if (String(state) !== "end") throw invalid();
    return { form, cleanup };
  } catch (error) { try { await reader.cancel(); } catch { /* Preserve the original read/write failure. */ } await handle?.close(); cleanup(); throw error; }
  finally { reader.releaseLock(); }
}
