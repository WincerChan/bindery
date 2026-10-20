import { directoryEntries, EntryReader, entryName, entryOperation, errorMessage, optionalDirectory, readBytes, type KindleDirectory } from "./fs";
import type { PairedDevice } from "./identity";
import { TransferProgressReporter, type TransferProgress } from "./progress";
import { applyDevicePatches, withDeviceLock, type DevicePatch } from "./transaction";

export interface DeviceFont { filename: string; family: string; style: string; weight: number; italic: boolean; coverage: "R" | "B" | "I" | "BI" | string; size: number }
export interface FontFamily { name: string; fonts: DeviceFont[]; coverage: string[]; size: number }
export const isFontFile = (name: string) => /\.(ttf|otf)$/i.test(name) && !name.startsWith("._");
const fontMagic = (head: Uint8Array) => head.length >= 12 && (new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0) === 0x00010000 || new TextDecoder().decode(head.subarray(0, 4)) === "OTTO");
async function fontNames(file: File): Promise<{ family?: string; style?: string }> {
  const header = new Uint8Array(await file.slice(0, 65548).arrayBuffer());
  if (!fontMagic(header)) throw new Error(`无效的 TTF/OTF 字体：${file.name}`);
  const view = new DataView(header.buffer), count = view.getUint16(4);
  if (count > 4096 || 12 + count * 16 > header.length) throw new Error(`字体表损坏：${file.name}`);
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    if (new TextDecoder().decode(header.subarray(at, at + 4)) !== "name") continue;
    const offset = view.getUint32(at + 8), length = view.getUint32(at + 12);
    if (length > 1_048_576 || offset + length > file.size || length < 6) throw new Error(`字体名称表损坏：${file.name}`);
    const bytes = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()), names = new DataView(bytes.buffer), records = names.getUint16(2), strings = names.getUint16(4), found = new Map<number, { score: number; text: string }>();
    if (6 + records * 12 > length) throw new Error(`字体名称表损坏：${file.name}`);
    for (let n = 0; n < records; n++) {
      const pos = 6 + n * 12, platform = names.getUint16(pos), language = names.getUint16(pos + 4), id = names.getUint16(pos + 6), size = names.getUint16(pos + 8), start = strings + names.getUint16(pos + 10);
      if (![1, 2, 16, 17].includes(id) || start + size > length || ![0, 3].includes(platform) || size % 2) continue;
      const text = new TextDecoder("utf-16be").decode(bytes.subarray(start, start + size)).replace(/\0/g, "").trim(), score = (platform === 3 ? 2 : 1) + (language === 0x409 ? 2 : 0);
      if (text && (!found.has(id) || found.get(id)!.score < score)) found.set(id, { score, text });
    }
    return { family: found.get(16)?.text ?? found.get(1)?.text, style: found.get(17)?.text ?? found.get(2)?.text };
  }
  return {};
}
export async function inspectFont(file: File): Promise<DeviceFont> {
  const names = await fontNames(file), stem = file.name.replace(/\.(ttf|otf)$/i, ""), match = /(?:[-_ ]?)(ExtraLight|UltraLight|SemiBold|DemiBold|ExtraBold|UltraBold|Regular|Normal|Medium|Light|Thin|Bold|Black|Heavy|Italic|Oblique)(?:[-_ ]?(Italic|Oblique))?$/i.exec(stem);
  const family = names.family ?? (match ? stem.slice(0, match.index) || stem : stem), style = names.style ?? (match ? match.slice(1).filter(Boolean).join(" ") : "Regular");
  const token = style.replace(/[ _-]/g, "").toLowerCase(), italic = /italic|oblique/.test(token);
  const weight = /extra(?:bold)|ultrabold/.test(token) ? 800 : /semi(?:bold)|demibold/.test(token) ? 600 : /bold/.test(token) ? 700 : /black|heavy/.test(token) ? 900 : /extra(?:light)|ultralight/.test(token) ? 200 : /thin/.test(token) ? 100 : /light/.test(token) ? 300 : /medium/.test(token) ? 500 : 400;
  const coverage = weight === 400 ? italic ? "I" : "R" : weight === 700 ? italic ? "BI" : "B" : `${style}`;
  return { filename: file.name, family, style, weight, italic, coverage, size: file.size };
}
export async function listFonts(root: KindleDirectory, reader = new EntryReader(root)): Promise<FontFamily[]> {
  const dir = await reader.read("fonts", () => optionalDirectory(root, "fonts"));
  if (!dir) { await root.getDirectoryHandle("documents"); return []; }
  const families = new Map<string, FontFamily>();
  for (const entry of await reader.read("fonts", () => directoryEntries(root, dir, "fonts")) ?? []) {
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
export async function installFonts(device: PairedDevice, files: File[], options: FontInstallOptions = {}) {
  if (!files.length) throw new Error("请选择 TTF 或 OTF 字体文件");
  const check = () => { if (options.signal?.aborted) throw new DOMException("操作已取消", "AbortError"); };
  check();
  const rows: FontInstallFileProgress[] = files.map(file => ({ filename: file.name, state: "等待", message: "等待安装", loaded: 0, total: file.size, committing: false }));
  const total = files.reduce((sum, file) => sum + file.size, 0);
  let current = -1, loaded = 0, committing = false;
  const reporter = () => new TransferProgressReporter(value => options.onProgress?.({ ...value, files: rows.slice(), loaded, total, currentFile: files[current]?.name, committing,
    ...(value.state === "失败" ? { bytesPerSecond: undefined, etaSeconds: undefined } : {}),
  }));
  let progress = reporter();
  const report = (state: TransferProgress["state"], message: string, flush = false) => progress.report({ state, phase: "write", message, loaded, total }, flush);
  report("等待", "正在检查字体并等待设备");
  try {
    const fonts = await Promise.all(files.map(async file => { entryName(file.name); if (!isFontFile(file.name)) throw new Error("只支持 TTF 和 OTF 字体文件"); return inspectFont(file); }));
    check();
    return await withDeviceLock(device, async () => {
      check();
      const dir = await optionalDirectory(device.root, "fonts"), existing = new Set<string>();
      if (dir) for (const entry of await directoryEntries(device.root, dir, "fonts")) existing.add(entry.name.toLowerCase());
      for (const font of fonts) { const key = font.filename.toLowerCase(); if (existing.has(key)) throw new Error(`字体文件已存在：${font.filename}`); existing.add(key); }
      check();
      // Start throughput measurement after validation / waiting for the device lock.
      progress = reporter();
      const reporters = files.map((file, index) => new TransferProgressReporter(value => { rows[index] = { ...value, filename: file.name, loaded: value.loaded!, total: file.size, committing }; }));
      const patches = files.map(file => ({ path: ["fonts", file.name], data: file }));
      const indices = new Map<DevicePatch, number>(patches.map((patch, index) => [patch, index]));
      let preceding = 0;
      report("写入", "正在准备字体写入与恢复备份");
      // File snapshots are sliced by writeBytes; rollback backups and journal ordering are unchanged.
      await applyDevicePatches(device.root, patches, options.signal, (patch, value) => {
        const index = indices.get(patch)!, changed = index !== current;
        if (changed && current >= 0) {
          rows[current] = { ...rows[current], committing: false, message: "文件已写入，等待批次提交" };
          preceding += files[current].size;
        }
        current = index; committing = value.committing; loaded = preceding + value.loaded;
        const message = committing ? "正在提交字体文件" : "正在写入字体文件", flush = changed || committing || value.loaded === value.total;
        reporters[index].report({ state: "写入", phase: "write", message, loaded: value.loaded, total: value.total }, flush);
        report("写入", message, flush);
      });
      // A closed file can still be rolled back by a later patch: only the whole transaction is success.
      committing = false;
      for (let i = 0; i < rows.length; i++) rows[i] = { ...rows[i], state: "完成", message: "字体文件安装完成", committing: false, etaSeconds: 0 };
      report("完成", "字体安装完成", true);
      return fonts;
    });
  } catch (error) {
    committing = false;
    const message = errorMessage(error);
    for (let i = 0; i < rows.length; i++) rows[i] = { ...rows[i], state: "失败", message, committing: false, bytesPerSecond: undefined, etaSeconds: undefined };
    report("失败", message, true);
    throw error;
  }
}
export async function deleteFontFamily(device: PairedDevice, familyName: string) {
  return withDeviceLock(device, async () => {
    const family = (await listFonts(device.root)).find(f => f.name === familyName);
    if (!family) throw new Error("字体家族不存在");
    await applyDevicePatches(device.root, family.fonts.map(f => ({ path: ["fonts", f.filename], data: null })));
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
