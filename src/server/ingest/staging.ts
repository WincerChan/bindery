import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { LibraryStorage } from "../storage";
import { newBookId } from "../storage";
import { readEnv } from "../env";

export interface StagedUpload { token: string; filename: string; content_type: string; kind: string; payload_name: string; payload_path: string; size: number }
export interface UploadFile { name: string; type: string; stream(): ReadableStream<Uint8Array> }
export const validId = (id: string) => /^[a-f0-9]{32}$/.test(id);
export function normalizeTokens(values: FormDataEntryValue[]): string[] { return [...new Set(values.flatMap(v => typeof v === "string" && validId(v.trim().toLowerCase()) ? [v.trim().toLowerCase()] : []))]; }
export function stageRoot(_library: LibraryStorage): string {
  const root = readEnv("BINDERY_STAGE_DIR") || join(tmpdir(), "bindery-ingest-stage");
  mkdirSync(root, { recursive: true }); return root;
}
export const queueDirectory = (library: LibraryStorage, id: string) => {
  if (!validId(id)) throw new Error("Invalid queue ID");
  return join(library.base, ".ingest-queue", id);
};
export function detectSourceType(filename: string, type: string, probe: Uint8Array): string {
  const ext = extname(filename).toLowerCase();
  if (ext === ".epub") return "epub";
  if (ext === ".txt") return "txt";
  if (type === "application/epub+zip" || probe[0] === 80 && probe[1] === 75) return "epub";
  if (type.startsWith("text/")) return "txt";
  const sample = probe.subarray(0, 4096);
  return sample.length && !sample.includes(0) && sample.filter(b => b < 9 || b > 13 && b < 32).length / sample.length < .02 ? "txt" : "unknown";
}
export async function persistUpload(file: UploadFile, directory: string): Promise<Omit<StagedUpload, "token">> {
  mkdirSync(directory, { recursive: true });
  const payload_name = "payload" + (extname(file.name).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".bin"), payload_path = join(directory, payload_name);
  let size = 0, probe = Buffer.alloc(0);
  async function* chunks() {
    const reader = file.stream().getReader();
    try { while (true) {
      const { value: chunk, done } = await reader.read(); if (done) break;
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (probe.length < 4096) probe = Buffer.concat([probe, bytes.subarray(0, 4096 - probe.length)]);
      yield bytes;
    } } finally { reader.releaseLock(); }
  }
  try { await pipeline(Readable.from(chunks()), createWriteStream(payload_path, { flags: "wx" })); }
  catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
  return { filename: file.name || "upload", content_type: file.type, kind: detectSourceType(file.name, file.type, probe), payload_name, payload_path, size };
}
export async function stageUpload(library: LibraryStorage, file: UploadFile): Promise<StagedUpload> {
  const token = newBookId(), directory = join(stageRoot(library), token);
  const entry = await persistUpload(file, directory);
  writeFileSync(join(directory, "meta.json"), JSON.stringify(entry));
  return { token, ...entry };
}
export function loadStaged(library: LibraryStorage, token: string): StagedUpload | null {
  if (!validId(token)) return null;
  const directory = join(stageRoot(library), token), path = join(directory, "meta.json");
  if (!existsSync(path)) return null;
  let data: Partial<StagedUpload>;
  try { data = JSON.parse(readFileSync(path, "utf8")); } catch (e) { if (e instanceof SyntaxError) return null; throw e; }
  if (typeof data.payload_name !== "string" || data.payload_name !== basename(data.payload_name) || /[\\]/.test(data.payload_name) || data.payload_name === "..") return null;
  const payload_path = join(directory, data.payload_name);
  if (!statSync(payload_path, { throwIfNoEntry: false })?.isFile()) return null;
  return { token, filename: typeof data.filename === "string" ? data.filename : "upload", content_type: data.content_type || "", kind: data.kind || "unknown", payload_name: data.payload_name, payload_path, size: statSync(payload_path).size };
}
export function cleanupStaged(library: LibraryStorage, token: string): void {
  if (validId(token)) rmSync(join(stageRoot(library), token), { recursive: true, force: true });
}
export function cleanupStagedExcept(library: LibraryStorage, tokens: string[] = []): number {
  const root = stageRoot(library), keep = new Set(tokens); let count = 0;
  for (const child of readdirSync(root, { withFileTypes: true })) if (child.isDirectory() && !keep.has(child.name)) {
    rmSync(join(root, child.name), { recursive: true, force: true }); count++;
  }
  return count;
}
