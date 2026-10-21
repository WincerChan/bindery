/**
 * KEPUB converter aligned with kepubify v4.0.4's default options.
 *
 * The package entries are copied with their original DEFLATE stream when they
 * are not transformed, so images/fonts are never decompressed or recompressed.
 * XHTML is tokenized and rewritten in one pass (see `kepub-html.ts`).
 */
import { Zip, ZipPassThrough, deflateSync, inflateSync } from "fflate";
import { basename, dirname, joinpath } from "./archive";
import { kepubTitlepageHasContent, transformKepubContent } from "./kepub-html";
import { localName, parseXmlDocument, serializeXmlDocument, xmlAttribute, xmlChildren, xmlDescendants, type XmlElement } from "./kepub-xml";

const decoder = new TextDecoder("utf-8", { fatal: false });
const bomPreservingDecoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
const encoder = new TextEncoder();
export const KEPUB_MIMETYPE = "application/epub+zip";
export const DUMMY_TITLEPAGE_NAME = "kepubify-titlepage-dummy.xhtml";
export const DUMMY_TITLEPAGE = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head><title></title></head><body><p style="text-align: center; margin: 4em 0; font-size: .7em; font-style: italic;">Page intentionally left blank by kepubify.</p></body></html>`;

export interface KepubZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  compressed: Uint8Array<ArrayBuffer>;
}
export interface KepubStats { entries: number; transformed: number; copied: number; removed: number; dummyTitlepage: boolean; unpackMs: number; opfMs: number; inflateMs: number; htmlMs: number; transformMs: number; compressMs: number; packMs: number; outputBytes: number }
export interface KepubResult { data: Uint8Array<ArrayBuffer>; stats: KepubStats }
export interface KepubOptions { signal?: AbortSignal; progress?: (stage: "inspecting" | "converting" | "done") => void }

const u16 = (view: DataView, offset: number) => view.getUint16(offset, true);
const u32 = (view: DataView, offset: number) => view.getUint32(offset, true);

/** Reads the central directory without inflating any member. */
export function readKepubZip(data: Uint8Array): KepubZipEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 65557); at--) if (u32(view, at) === 0x06054b50) { end = at; break; }
  if (end < 0) throw new Error("EPUB 不是有效的 ZIP 文件");
  const count = u16(view, end + 10), start = u32(view, end + 16);
  let offset = start;
  const entries: KepubZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (u32(view, offset) !== 0x02014b50) throw new Error("EPUB 的 ZIP 中央目录损坏");
    const flags = u16(view, offset + 8), method = u16(view, offset + 10), crc = u32(view, offset + 16);
    const compressedSize = u32(view, offset + 20), uncompressedSize = u32(view, offset + 24);
    const nameLength = u16(view, offset + 28), extraLength = u16(view, offset + 30), commentLength = u16(view, offset + 32);
    const localOffset = u32(view, offset + 42);
    const name = decoder.decode(data.subarray(offset + 46, offset + 46 + nameLength));
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error("暂不支持 ZIP64 的 EPUB");
    if (flags & 1) throw new Error("暂不支持加密的 EPUB");
    if (u32(view, localOffset) !== 0x04034b50) throw new Error("EPUB 的 ZIP 本地文件头损坏");
    const localName = u16(view, localOffset + 26), localExtra = u16(view, localOffset + 28);
    const dataOffset = localOffset + 30 + localName + localExtra;
    if (dataOffset + compressedSize > data.length) throw new Error("EPUB 的 ZIP 成员超出文件范围");
    entries.push({ name, method, flags, crc, compressedSize, uncompressedSize, localOffset, compressed: data.slice(dataOffset, dataOffset + compressedSize) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function entryText(entry: KepubZipEntry): string {
  if (entry.method === 0) return decoder.decode(entry.compressed);
  if (entry.method === 8) return decoder.decode(inflateSync(entry.compressed));
  throw new Error(`不支持的 ZIP 压缩方法：${entry.method}`);
}
function entryTextPreserveBom(entry: KepubZipEntry): string {
  if (entry.method === 0) return bomPreservingDecoder.decode(entry.compressed);
  if (entry.method === 8) return bomPreservingDecoder.decode(inflateSync(entry.compressed));
  throw new Error(`不支持的 ZIP 压缩方法：${entry.method}`);
}
function entryBytes(entry: KepubZipEntry): Uint8Array<ArrayBuffer> {
  if (entry.method === 0) return new Uint8Array(entry.compressed);
  if (entry.method === 8) return inflateSync(entry.compressed);
  throw new Error(`不支持的 ZIP 压缩方法：${entry.method}`);
}

export const kepubFileFilter = (name: string): boolean => {
  const base = basename(name), dir = dirname(name);
  return base === "calibre_bookmarks.txt" || base === "iTunesMetadata.plist" || base === "iTunesArtwork.plist" || base === ".DS_STORE"
    || base === "thumbs.db" || base === "Thumbs.db" || dir === "__MACOSX";
};

function findMember(entries: KepubZipEntry[], path: string): KepubZipEntry | undefined {
  const exact = entries.find(entry => entry.name === path);
  if (exact) return exact;
  const lower = path.toLowerCase();
  return entries.find(entry => entry.name.toLowerCase() === lower);
}

export function readContainerPackage(containerXml: string): string {
  const document = parseXmlDocument(containerXml);
  if (!document.root) throw new Error("EPUB 缺少 OCF container");
  const version = xmlAttribute(document.root, "version");
  if (version !== "1.0") throw new Error(`EPUB 的 OCF 版本无效：${version ?? "缺失"}`);
  const rootfile = xmlDescendants(document.root, "rootfile").find(node => xmlAttribute(node, "media-type") === "application/oebps-package+xml");
  const path = rootfile ? xmlAttribute(rootfile, "full-path") : undefined;
  if (!path) throw new Error("EPUB 的 OCF container 没有有效的 package 文档");
  return path;
}

function removeChild(parent: XmlElement, target: XmlElement) {
  const index = parent.children.indexOf(target);
  if (index >= 0) parent.children.splice(index, 1);
}

/** Adds the EPUB3 cover-image property and drops Calibre bookkeeping metadata. */
export function transformKepubOpf(opfXml: string): { xml: string; root: XmlElement; manifest: XmlElement | undefined; spine: XmlElement | undefined } {
  const bom = opfXml.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
  const document = parseXmlDocument(opfXml);
  if (!document.root) throw new Error("EPUB 的 OPF 缺少 package 元素");
  const root = document.root;
  const all = [root, ...xmlDescendants(root)];
  const coverMeta = all.find(node => localName(node.name) === "meta" && xmlAttribute(node, "name") === "cover");
  const coverId = coverMeta ? xmlAttribute(coverMeta, "content") ?? "cover" : "cover";
  const cover = all.find(node => xmlAttribute(node, "id") === coverId);
  if (cover) {
    const property = cover.attrs.find(attr => attr.name === "properties");
    if (property) property.value = "cover-image";
    else cover.attrs.push({ name: "properties", value: "cover-image" });
  }
  for (const node of all) {
    if (localName(node.name) === "meta" && xmlAttribute(node, "name") === "calibre:timestamp" && node !== root) {
      const parent = all.find(candidate => candidate.children.includes(node));
      if (parent) removeChild(parent, node);
    }
    if (localName(node.name) === "contributor" && xmlAttribute(node, "role") === "bkp" && node !== root) {
      const parent = all.find(candidate => candidate.children.includes(node));
      if (parent) removeChild(parent, node);
    }
  }
  return {
    xml: bom + serializeXmlDocument(document),
    root,
    manifest: xmlChildren(root, "manifest")[0],
    spine: xmlChildren(root, "spine")[0],
  };
}

/** Adds kepubify's blank first page when the heuristic says the book needs one. */
export function addKepubDummyTitlepage(opfXml: string, opfPath: string, content: (path: string) => string | undefined): { xml: string; dummyPath: string | null } {
  const bom = opfXml.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
  const document = parseXmlDocument(opfXml);
  if (!document.root) throw new Error("EPUB 的 OPF 缺少 package 元素");
  const root = document.root;
  const manifest = xmlChildren(root, "manifest")[0], spine = xmlChildren(root, "spine")[0];
  if (!manifest || !spine) return { xml: bom + serializeXmlDocument(document), dummyPath: null };
  const items = xmlChildren(manifest, "item");
  const firstRef = xmlChildren(spine, "itemref").find(ref => xmlAttribute(ref, "linear") !== "no");
  const idref = firstRef ? xmlAttribute(firstRef, "idref") : undefined;
  if (!idref) return { xml: bom + serializeXmlDocument(document), dummyPath: null };
  const item = items.find(candidate => xmlAttribute(candidate, "id") === idref);
  const href = item ? xmlAttribute(item, "href") ?? "" : "";
  const extension = (href.match(/\.[^./\\]*$/)?.[0] ?? "").toLowerCase();
  if (!href || ![".htm", ".html", ".xhtml"].includes(extension)) return { xml: bom + serializeXmlDocument(document), dummyPath: null };
  const name = basename(href).toLowerCase();
  if (name.includes("cover") || name.includes("title")) return { xml: bom + serializeXmlDocument(document), dummyPath: null };
  const source = content(joinpath(dirname(opfPath), href));
  if (source === undefined || !kepubTitlepageHasContent(source)) return { xml: bom + serializeXmlDocument(document), dummyPath: null };
  manifest.children.push({ type: "element", name: "item", attrs: [
    { name: "id", value: "kepubify-titlepage-dummy" },
    { name: "href", value: DUMMY_TITLEPAGE_NAME },
    { name: "media-type", value: "application/xhtml+xml" },
  ], children: [] });
  spine.children.unshift({ type: "element", name: "itemref", attrs: [{ name: "idref", value: "kepubify-titlepage-dummy" }], children: [] });
  return { xml: bom + serializeXmlDocument(document), dummyPath: joinpath(dirname(opfPath), DUMMY_TITLEPAGE_NAME) };
}

interface WriteEntry { name: string; data?: Uint8Array; raw?: KepubZipEntry }
class RawZipEntry extends ZipPassThrough {
  private readonly packed: Uint8Array<ArrayBuffer>;
  constructor(name: string, source: KepubZipEntry) {
    super(name);
    this.packed = source.compressed;
    this.compression = source.method;
    this.crc = source.crc;
    this.size = source.uncompressedSize;
  }
  send(): void { this.ondata(null, this.packed, true); }
}
class DeflatedZipEntry extends ZipPassThrough {
  private readonly packed: Uint8Array<ArrayBuffer>;
  constructor(name: string, data: Uint8Array, level: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9) {
    super(name);
    this.packed = deflateSync(data, { level });
    this.compression = 8;
  }
  protected override process(_chunk: Uint8Array<ArrayBuffer>, final: boolean): void { this.ondata(null, this.packed, final); }
}
class StoredZipEntry extends ZipPassThrough {
  constructor(name: string) { super(name); }
}

function writeKepubZip(entries: WriteEntry[], compressionLevel: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => { if (error) throw error; chunks.push(chunk); });
  try {
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (entry.raw) {
        const file = new RawZipEntry(entry.name, entry.raw);
        zip.add(file);
        file.send();
      } else if (index === 0) {
        const file = new StoredZipEntry(entry.name);
        zip.add(file); file.push(entry.data!, true);
      } else {
        const file = new DeflatedZipEntry(entry.name, entry.data!, compressionLevel);
        zip.add(file); file.push(entry.data!, true);
      }
    }
    zip.end();
  } catch (error) { zip.terminate(); throw error; }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0), output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

/**
 * Converts an EPUB byte array to a KEPUB byte array. All work is synchronous so
 * a Worker termination is the only cancellation boundary.
 */
interface PreparedKepub { output: WriteEntry[]; stats: Omit<KepubStats, "compressMs" | "packMs" | "outputBytes"> }
function prepareKepub(data: Uint8Array, options: KepubOptions = {}): PreparedKepub {
  if (options.signal?.aborted) throw new DOMException("操作已取消", "AbortError");
  options.progress?.("inspecting");
  const start = performance.now();
  const entries = readKepubZip(data);
  const unpackMs = performance.now() - start;
  const container = entries.find(entry => entry.name === "META-INF/container.xml");
  if (!container) throw new Error("EPUB 缺少 META-INF/container.xml");
  const opfPath = readContainerPackage(entryText(container));
  const opfEntry = findMember(entries, opfPath);
  if (!opfEntry) throw new Error(`EPUB 缺少 OPF：${opfPath}`);
  const opfSource = entryTextPreserveBom(opfEntry);
  options.progress?.("converting");
  const transformStart = performance.now();
  const opfStart = performance.now();
  const firstPass = transformKepubOpf(opfSource);
  const opfBom = opfSource.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
  const document = parseXmlDocument(firstPass.xml);
  const root = document.root!;
  const items = firstPass.manifest ? xmlChildren(firstPass.manifest, "item") : [];
  const contentPaths = items.flatMap(item => {
    const href = xmlAttribute(item, "href") ?? "";
    if (!href) return [];
    const media = (xmlAttribute(item, "media-type") ?? "").toLowerCase();
    const extension = (href.match(/\.[^./\\]*$/)?.[0] ?? "").toLowerCase();
    return media === "application/xhtml+xml" || media === "text/html" || [".htm", ".html", ".xhtml"].includes(extension)
      ? [joinpath(dirname(opfPath), href)]
      : [];
  });
  const readContent = (path: string) => { const entry = findMember(entries, path); return entry ? entryText(entry) : undefined; };
  const dummy = addKepubDummyTitlepage(opfBom + serializeXmlDocument(document), opfPath, readContent);
  const opfBytes = encoder.encode(dummy.xml);
  const opfMs = performance.now() - opfStart;
  const contentIndices = new Set<number>();
  for (const path of contentPaths) {
    const exact = entries.findIndex(entry => entry.name === path);
    const found = exact >= 0 ? exact : entries.findIndex(entry => entry.name.toLowerCase() === path.toLowerCase());
    if (found >= 0) contentIndices.add(found);
  }
  const opfIndex = entries.indexOf(opfEntry);
  const transformed = new Map<number, Uint8Array>();
  transformed.set(opfIndex, opfBytes);
  let inflateMs = 0, htmlMs = 0;
  for (const index of contentIndices) {
    if (options.signal?.aborted) throw new DOMException("操作已取消", "AbortError");
    const entry = entries[index];
    const inflateStart = performance.now();
    const source = entryText(entry);
    inflateMs += performance.now() - inflateStart;
    const htmlStart = performance.now();
    transformed.set(index, encoder.encode(transformKepubContent(source).html));
    htmlMs += performance.now() - htmlStart;
  }
  const transformMs = performance.now() - transformStart;
  const output: WriteEntry[] = [{ name: "mimetype", data: encoder.encode(KEPUB_MIMETYPE) }];
  let copied = 0, removed = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.name === "mimetype") { removed++; continue; }
    if (entry.name.endsWith("/")) { removed++; continue; }
    if (kepubFileFilter(entry.name)) { removed++; continue; }
    const changed = transformed.get(index);
    if (changed) output.push({ name: entry.name, data: changed });
    else { output.push({ name: entry.name, raw: entry }); copied++; }
  }
  if (dummy.dummyPath) output.push({ name: dummy.dummyPath, data: encoder.encode(DUMMY_TITLEPAGE) });
  return { output, stats: { entries: entries.length, transformed: transformed.size, copied, removed, dummyTitlepage: Boolean(dummy.dummyPath), unpackMs, opfMs, inflateMs, htmlMs, transformMs } };
}

export function convertToKepub(data: Uint8Array, options: KepubOptions = {}, compressionLevel: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 1): KepubResult {
  const prepared = prepareKepub(data, options);
  const packStart = performance.now();
  const packed = writeKepubZip(prepared.output, compressionLevel);
  const packMs = performance.now() - packStart;
  options.progress?.("done");
  return { data: packed, stats: { ...prepared.stats, compressMs: 0, packMs, outputBytes: packed.byteLength } };
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index++) crc = crcTable[(crc ^ data[index]) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
async function deflateRawNative(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new CompressionStream("deflate-raw"), output = new Response(stream.readable).arrayBuffer(), writer = stream.writable.getWriter();
  await writer.write(new Uint8Array(data)); await writer.close();
  return new Uint8Array(await output);
}
/**
 * Worker-friendly variant. Uses the browser/Node native "deflate-raw" stream
 * when available, then assembles the ZIP from the pre-compressed members. Member
 * bytes are identical to `convertToKepub`; only compression timing differs.
 */
export async function convertToKepubAsync(data: Uint8Array, options: KepubOptions = {}): Promise<KepubResult> {
  if (typeof CompressionStream === "undefined") return convertToKepub(data, options);
  const prepared = prepareKepub(data, options);
  const packStart = performance.now();
  const compressStart = performance.now();
  const output = await Promise.all(prepared.output.map(async (entry, index) => {
    if (entry.raw || index === 0) return entry;
    const bytes = entry.data!;
    const compressed = await deflateRawNative(bytes);
    return { name: entry.name, raw: { name: entry.name, method: 8, flags: 0, crc: crc32(bytes), compressedSize: compressed.byteLength, uncompressedSize: bytes.byteLength, localOffset: 0, compressed } };
  }));
  const compressMs = performance.now() - compressStart;
  const packed = writeKepubZip(output, 1);
  const packMs = performance.now() - packStart;
  options.progress?.("done");
  return { data: packed, stats: { ...prepared.stats, compressMs, packMs, outputBytes: packed.byteLength } };
}

export { transformKepubContent };
export const kepubTitlepageRequired = kepubTitlepageHasContent;
export const kepubEntryText = entryText;
export const kepubEntryBytes = entryBytes;
