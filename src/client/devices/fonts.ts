import { directoryEntries, EntryReader, entryName, entryOperation, errorMessage, optionalDirectory, readBytes, type KindleDirectory } from "./fs";
import type { PairedDevice } from "./identity";
import { TransferProgressReporter, type TransferProgress } from "./progress";
import { applyDevicePatchesFor, withDeviceLock, type DevicePatch } from "./transaction";
import type { DeviceKind } from "./models";
import { koboFamilyName, renameFontFamily } from "../../core/font-names";

/** `cjk`: the font maps common Chinese characters; absent when its character map could not be read. */
export interface DeviceFont { filename: string; family: string; style: string; weight: number; italic: boolean; coverage: "R" | "B" | "I" | "BI" | string; size: number; postscript?: string; cjk?: boolean }
export interface FontFamily { name: string; fonts: DeviceFont[]; coverage: string[]; size: number }
/** A family is Chinese when any of its files maps Chinese characters (Chinese fonts carry Latin glyphs too). */
export const isCjkFamily = (family: FontFamily) => family.fonts.some(font => font.cjk);
export type FontLanguage = "all" | "cjk" | "latin";
/** Every family that is not Chinese counts as English, including ones whose character map could not be read. */
export const matchesFontLanguage = (family: FontFamily, language: FontLanguage) => language === "all" || (language === "cjk") === isCjkFamily(family);
export const isFontFile = (name: string) => /\.(ttf|otf)$/i.test(name) && !name.startsWith("._");
const fontMagic = (head: Uint8Array) => head.length >= 12 && (new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0) === 0x00010000 || new TextDecoder().decode(head.subarray(0, 4)) === "OTTO");
// 的 一 是 中: any two present means the font is meant for Chinese text.
const CJK_PROBES = [0x7684, 0x4e00, 0x662f, 0x4e2d];
/** Reads only the cmap subtable (format 4 or 12) and checks the probe characters; null when it cannot tell. */
async function mapsCjk(file: File, offset: number, length: number): Promise<boolean | null> {
  if (length < 4 || offset + length > file.size) return null;
  const head = new DataView(await file.slice(offset, offset + Math.min(length, 4 + 8 * 64)).arrayBuffer()), tables = Math.min(head.getUint16(2), 64);
  const records: { platform: number; encoding: number; at: number }[] = [];
  for (let i = 0; i < tables && 12 + i * 8 <= head.byteLength; i++) records.push({ platform: head.getUint16(4 + i * 8), encoding: head.getUint16(6 + i * 8), at: head.getUint32(8 + i * 8) });
  const rank = (r: { platform: number; encoding: number }) => r.platform === 3 && r.encoding === 10 ? 0 : r.platform === 0 && r.encoding >= 4 ? 1 : r.platform === 3 && r.encoding === 1 ? 2 : r.platform === 0 ? 3 : 9;
  const best = records.filter(r => rank(r) < 9).sort((a, b) => rank(a) - rank(b))[0];
  if (!best || best.at + 8 > length) return null;
  const start = offset + best.at, sub = new DataView(await file.slice(start, start + 8).arrayBuffer()), format = sub.getUint16(0);
  const size = format === 12 ? sub.getUint32(4) : format === 4 ? sub.getUint16(2) : 0;
  if (!size || size > 16_777_216 || start + size > file.size) return null;
  const data = new DataView(await file.slice(start, start + size).arrayBuffer());
  const has = (code: number) => {
    if (format === 12) {
      for (let i = 0, groups = data.getUint32(12); i < groups && 16 + i * 12 + 12 <= size; i++) {
        const at = 16 + i * 12; if (code >= data.getUint32(at) && code <= data.getUint32(at + 4)) return true;
      }
      return false;
    }
    const segments = data.getUint16(6) / 2, ends = 14, starts = ends + segments * 2 + 2, deltas = starts + segments * 2, ranges = deltas + segments * 2;
    for (let i = 0; i < segments; i++) {
      if (code > data.getUint16(ends + i * 2) || code < data.getUint16(starts + i * 2)) continue;
      const range = data.getUint16(ranges + i * 2);
      if (!range) return ((code + data.getInt16(deltas + i * 2)) & 0xffff) !== 0;
      const glyphAt = ranges + i * 2 + range + (code - data.getUint16(starts + i * 2)) * 2;
      return glyphAt + 2 <= size && data.getUint16(glyphAt) !== 0;
    }
    return false;
  };
  try { return CJK_PROBES.filter(has).length >= 2; } catch { return null; }
}
async function fontNames(file: File): Promise<{ family?: string; style?: string; postscript?: string; cjk?: boolean }> {
  const header = new Uint8Array(await file.slice(0, 65548).arrayBuffer());
  if (!fontMagic(header)) throw new Error(`无效的 TTF/OTF 字体：${file.name}`);
  const view = new DataView(header.buffer), count = view.getUint16(4);
  if (count > 4096 || 12 + count * 16 > header.length) throw new Error(`字体表损坏：${file.name}`);
  let cjk: boolean | null = null;
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    if (new TextDecoder().decode(header.subarray(at, at + 4)) === "cmap") { cjk = await mapsCjk(file, view.getUint32(at + 8), view.getUint32(at + 12)).catch(() => null); break; }
  }
  const withCjk = <T extends object>(names: T) => cjk === null ? names : { ...names, cjk };
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    if (new TextDecoder().decode(header.subarray(at, at + 4)) !== "name") continue;
    const offset = view.getUint32(at + 8), length = view.getUint32(at + 12);
    if (length > 1_048_576 || offset + length > file.size || length < 6) throw new Error(`字体名称表损坏：${file.name}`);
    const bytes = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()), names = new DataView(bytes.buffer), records = names.getUint16(2), strings = names.getUint16(4), found = new Map<number, { score: number; text: string }>();
    if (6 + records * 12 > length) throw new Error(`字体名称表损坏：${file.name}`);
    for (let n = 0; n < records; n++) {
      const pos = 6 + n * 12, platform = names.getUint16(pos), language = names.getUint16(pos + 4), id = names.getUint16(pos + 6), size = names.getUint16(pos + 8), start = strings + names.getUint16(pos + 10);
      if (![1, 2, 6, 16, 17].includes(id) || start + size > length || ![0, 3].includes(platform) || size % 2) continue;
      const text = new TextDecoder("utf-16be").decode(bytes.subarray(start, start + size)).replace(/\0/g, "").trim(), score = (platform === 3 ? 2 : 1) + (language === 0x409 ? 2 : 0);
      if (text && (!found.has(id) || found.get(id)!.score < score)) found.set(id, { score, text });
    }
    return withCjk({ family: found.get(16)?.text ?? found.get(1)?.text, style: found.get(17)?.text ?? found.get(2)?.text, postscript: found.get(6)?.text });
  }
  return withCjk({});
}
export async function inspectFont(file: File): Promise<DeviceFont> {
  const names = await fontNames(file), stem = file.name.replace(/\.(ttf|otf)$/i, ""), match = /(?:[-_ ]?)(ExtraLight|UltraLight|SemiBold|DemiBold|ExtraBold|UltraBold|Regular|Normal|Medium|Light|Thin|Bold|Black|Heavy|Italic|Oblique)(?:[-_ ]?(Italic|Oblique))?$/i.exec(stem);
  const family = names.family ?? (match ? stem.slice(0, match.index) || stem : stem), style = names.style ?? (match ? match.slice(1).filter(Boolean).join(" ") : "Regular");
  const token = style.replace(/[ _-]/g, "").toLowerCase(), italic = /italic|oblique/.test(token);
  const weight = /extra(?:bold)|ultrabold/.test(token) ? 800 : /semi(?:bold)|demibold/.test(token) ? 600 : /bold/.test(token) ? 700 : /black|heavy/.test(token) ? 900 : /extra(?:light)|ultralight/.test(token) ? 200 : /thin/.test(token) ? 100 : /light/.test(token) ? 300 : /medium/.test(token) ? 500 : 400;
  const coverage = weight === 400 ? italic ? "I" : "R" : weight === 700 ? italic ? "BI" : "B" : `${style}`;
  return { filename: file.name, family, style, weight, italic, coverage, size: file.size, ...(names.postscript ? { postscript: names.postscript } : {}), ...(names.cjk === undefined ? {} : { cjk: names.cjk }) };
}
export async function listFonts(root: KindleDirectory, reader = new EntryReader(root), kind: DeviceKind = "kindle"): Promise<FontFamily[]> {
  const dir = await reader.read("fonts", () => optionalDirectory(root, "fonts", root, "", kind));
  if (!dir) { await (kind === "kobo" ? root.getDirectoryHandle(".kobo") : root.getDirectoryHandle("documents")); return []; }
  const families = new Map<string, FontFamily>();
  for (const entry of await reader.read("fonts", () => directoryEntries(root, dir, "fonts", kind)) ?? []) {
    if (entry.kind !== "file" || !isFontFile(entry.name)) continue;
    const file = await reader.read(`fonts/${entry.name}`, () => entry.getFile()); if (!file) continue;
    let font: DeviceFont;
    try { const inspected = await reader.read(`fonts/${entry.name}`, () => inspectFont(file)); if (!inspected) continue; font = inspected; }
    catch (error) { if (error instanceof Error && /字体/.test(error.message)) { font = { filename: file.name, family: file.name.replace(/\.(ttf|otf)$/i, ""), style: "无法解析", weight: 400, italic: false, coverage: "未知", size: file.size }; } else throw error; }
    const family = families.get(font.family) ?? { name: font.family, fonts: [], coverage: [], size: 0 };
    family.fonts.push(font); family.size += font.size; if (!family.coverage.includes(font.coverage)) family.coverage.push(font.coverage); families.set(family.name, family);
  }
  return [...families.values()].sort((a, b) => a.name.localeCompare(b.name)).map(f => ({ ...f, fonts: f.fonts.sort((a, b) => a.weight - b.weight || Number(a.italic) - Number(b.italic)) }));
}
export interface FontInstallFileProgress extends Pick<TransferProgress, "state" | "message" | "bytesPerSecond" | "etaSeconds"> {
  filename: string; loaded: number; total: number; committing: boolean;
}
export interface FontInstallProgress extends TransferProgress {
  files: readonly FontInstallFileProgress[];
  loaded: number; total: number; currentFile?: string; committing: boolean;
}
export interface FontInstallOptions { signal?: AbortSignal; onProgress?: (progress: FontInstallProgress) => void }
const koboFontStyle = (font: DeviceFont) => font.italic && font.weight >= 600 ? "BoldItalic" : font.italic ? "Italic" : font.weight >= 600 ? "Bold" : "Regular";
const safeFamily = (family: string) => family.normalize("NFC").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").trim() || "Font";
/** Kobo groups fonts by `<Family>-Regular|Bold|Italic|BoldItalic`; Kindle keeps the user file name. */
export function fontTargetName(kind: DeviceKind, font: DeviceFont, original: string): string {
  if (kind === "kindle") return original;
  const extension = (original.match(/\.(ttf|otf)$/i)?.[0] ?? ".ttf").toLowerCase();
  return `${safeFamily(font.family)}-${koboFontStyle(font)}${extension}`;
}
export async function installFonts(device: PairedDevice, files: File[], options: FontInstallOptions = {}) {
  const kind = device.identity.kind;
  if (!files.length) throw new Error("请选择 TTF 或 OTF 字体文件");
  const check = () => { if (options.signal?.aborted) throw new DOMException("操作已取消", "AbortError"); };
  check();
  const rows: FontInstallFileProgress[] = files.map(file => ({ filename: file.name, state: "等待", message: "等待安装", loaded: 0, total: file.size, committing: false }));
  let total = files.reduce((sum, file) => sum + file.size, 0);
  let current = -1, loaded = 0, committing = false;
  const reporter = () => new TransferProgressReporter(value => options.onProgress?.({ ...value, files: rows.slice(), loaded, total, currentFile: files[current]?.name, committing,
    ...(value.state === "失败" ? { bytesPerSecond: undefined, etaSeconds: undefined } : {}),
  }));
  let progress = reporter();
  const report = (state: TransferProgress["state"], message: string, flush = false) => progress.report({ state, phase: "write", message, loaded, total }, flush);
  report("等待", "正在检查字体并等待设备");
  try {
    const inspected = await Promise.all(files.map(async file => { entryName(file.name); if (!isFontFile(file.name)) throw new Error("只支持 TTF 和 OTF 字体文件"); return inspectFont(file); }));
    // Kobo needs a family name that survives its unquoted CSS; the font's own names and file name change together.
    const prepared = await Promise.all(inspected.map(async (font, index) => {
      const family = kind === "kobo" ? koboFamilyName(font.family, font.postscript) : font.family;
      if (family === font.family) return { font, data: files[index] as File | Uint8Array<ArrayBuffer>, renamedFrom: null };
      const renamed = renameFontFamily(new Uint8Array(await files[index].arrayBuffer()), { family, full: `${family} ${font.style}` });
      return { font: { ...font, family }, data: renamed ?? files[index], renamedFrom: font.family };
    }));
    const fonts = prepared.map(item => item.font), sizes = prepared.map(item => item.data instanceof Uint8Array ? item.data.byteLength : item.data.size);
    total = sizes.reduce((sum, size) => sum + size, 0); rows.forEach((row, index) => { row.total = sizes[index]; });
    const targets = fonts.map((font, index) => fontTargetName(kind, font, files[index].name));
    if (new Set(targets.map(name => name.toLowerCase())).size !== targets.length) throw new Error("多个字体文件会安装为同一个 Kobo 文件名，请检查字体家族与样式");
    check();
    return await withDeviceLock(device, async () => {
      check();
      const dir = await optionalDirectory(device.root, "fonts", device.root, "", kind), existing = new Set<string>();
      if (dir) for (const entry of await directoryEntries(device.root, dir, "fonts", kind)) existing.add(entry.name.toLowerCase());
      for (const filename of targets) { const key = filename.toLowerCase(); if (existing.has(key)) throw new Error(`字体文件已存在：${filename}`); existing.add(key); }
      check();
      // Start throughput measurement after validation / waiting for the device lock.
      progress = reporter();
      const reporters = files.map((_file, index) => new TransferProgressReporter(value => { rows[index] = { ...value, filename: targets[index], loaded: value.loaded!, total: sizes[index], committing }; }));
      rows.forEach((row, index) => { row.filename = targets[index]; });
      const patches = prepared.map((item, index) => ({ path: ["fonts", targets[index]], data: item.data }));
      const indices = new Map<DevicePatch, number>(patches.map((patch, index) => [patch, index]));
      let preceding = 0;
      report("写入", "正在准备字体写入与恢复备份");
      // File snapshots are sliced by writeBytes; rollback backups and journal ordering are unchanged.
      await applyDevicePatchesFor(device.root, kind, patches, options.signal, (patch, value) => {
        const index = indices.get(patch)!, changed = index !== current;
        if (changed && current >= 0) {
          rows[current] = { ...rows[current], committing: false, message: "文件已写入，等待批次提交" };
          preceding += rows[current].total;
        }
        current = index; committing = value.committing; loaded = preceding + value.loaded;
        const message = committing ? "正在提交字体文件" : "正在写入字体文件", flush = changed || committing || value.loaded === value.total;
        reporters[index].report({ state: "写入", phase: "write", message, loaded: value.loaded, total: value.total }, flush);
        report("写入", message, flush);
      });
      // A closed file can still be rolled back by a later patch: only the whole transaction is success.
      committing = false;
      for (let i = 0; i < rows.length; i++) {
        const renamedFrom = prepared[i].renamedFrom;
        rows[i] = { ...rows[i], state: "完成", message: renamedFrom ? `字体文件安装完成（Kobo 不支持名称「${renamedFrom}」，已改名为「${fonts[i].family}」）` : "字体文件安装完成", committing: false, etaSeconds: 0 };
      }
      report("完成", "字体安装完成", true);
      return fonts;
    });
  } catch (error) {
    committing = false;
    const message = errorMessage(error, kind);
    for (let i = 0; i < rows.length; i++) rows[i] = { ...rows[i], state: "失败", message, committing: false, bytesPerSecond: undefined, etaSeconds: undefined };
    report("失败", message, true);
    throw error;
  }
}
export async function deleteFontFamily(device: PairedDevice, familyName: string) {
  return withDeviceLock(device, async () => {
    const family = (await listFonts(device.root, new EntryReader(device.root, [], device.identity.kind), device.identity.kind)).find(f => f.name === familyName);
    if (!family) throw new Error("字体家族不存在");
    await applyDevicePatchesFor(device.root, device.identity.kind, family.fonts.map(f => ({ path: ["fonts", f.filename], data: null })));
  });
}
export async function readFont(root: KindleDirectory, filename: string) {
  entryName(filename); if (!isFontFile(filename)) throw new Error("只支持 TTF 和 OTF 字体文件");
  return entryOperation(root, `fonts/${filename}`, async () => readBytes(await root.getDirectoryHandle("fonts"), filename));
}
/** Caller adds to document.fonts and removes it when the preview is disposed. */
export async function loadPreviewFont(device: PairedDevice, font: DeviceFont, alias = font.family): Promise<FontFace> {
  const face = new FontFace(alias, (await readFont(device.root, font.filename)).buffer, { weight: String(font.weight), style: font.italic ? "italic" : "normal" });
  return face.load();
}
