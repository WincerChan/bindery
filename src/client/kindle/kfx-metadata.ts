import { IonReader, ionField, type IonValue } from "../boko/kfx";

/** Reads only boko's `kindle_title_metadata` from KFX container headers and entities. */
export class KfxMetadataError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "KfxMetadataError"; }
}
export interface KfxBookMetadata { title: string | null; author: string | null }
const fail = (message: string): never => { throw new KfxMetadataError(message); };
const integer = (value: IonValue, name: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fail(`无效的 KFX ${name}`);
  return value;
};
function titleMetadata(value: IonValue): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const walk = (node: IonValue) => {
    if (Array.isArray(node)) { for (const child of node) walk(child); return; }
    if (!node || typeof node !== "object" || !("fields" in node)) return;
    if (ionField(node, 495) === "kindle_title_metadata") {
      const entries = ionField(node, 258);
      for (const entry of Array.isArray(entries) ? entries : []) {
        const key = ionField(entry, 492), text = ionField(entry, 307);
        if (typeof key === "string" && typeof text === "string") found.push([key, text]);
      }
    }
    for (const [, child] of node.fields) walk(child);
  };
  walk(value);
  return found;
}
export async function readKfxBookMetadata(file: Blob): Promise<KfxBookMetadata> {
  const read = async (start: number, length: number): Promise<Uint8Array> => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > file.size) return fail("KFX 容器被截断");
    const bytes = new Uint8Array(await file.slice(start, start + length).arrayBuffer());
    if (bytes.length !== length) return fail("KFX 容器被截断");
    return bytes;
  };
  try {
    const headerBytes = await read(0, 18);
    if (new TextDecoder().decode(headerBytes.subarray(0, 4)) !== "CONT") return fail("无效的 KFX 容器");
    const header = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength), headerLength = header.getUint32(6, true);
    if (header.getUint16(4, true) !== 2 || headerLength < 18) return fail("不支持的 KFX 容器版本");
    const info = new IonReader(await read(header.getUint32(10, true), header.getUint32(14, true))).read();
    if (ionField(info, 410) !== 0 || ionField(info, 411) !== 0) return fail("不支持压缩或加密的 KFX");
    const indexStart = integer(ionField(info, 413), "索引偏移"), indexLength = integer(ionField(info, 414), "索引长度");
    if (!indexLength || indexLength % 24 || indexStart < 18 || indexStart + indexLength > headerLength) return fail("无效的 KFX 索引");
    const index = await read(indexStart, indexLength), view = new DataView(index.buffer, index.byteOffset, index.byteLength), entries: Array<[number, number]> = [];
    for (let at = 0; at < indexLength; at += 24) {
      const type = view.getUint32(at + 4, true), relative = view.getBigUint64(at + 8, true), size = view.getBigUint64(at + 16, true);
      if (type !== 490) continue;
      if (relative > BigInt(Number.MAX_SAFE_INTEGER) || size > BigInt(Number.MAX_SAFE_INTEGER)) return fail("无效的 KFX 实体");
      const offset = headerLength + Number(relative), length = Number(size);
      if (length < 10 || offset < headerLength || offset + length > file.size) return fail("无效的 KFX 实体");
      entries.push([offset, length]);
    }
    const metadata = new Map<string, string>();
    for (const [offset, length] of entries) {
      const bytes = await read(offset, length), data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), entityHeader = data.getUint32(6, true);
      if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "ENTY" || entityHeader < 10 || entityHeader >= length) return fail("无效的 KFX 实体");
      const encoding = new IonReader(bytes.subarray(10, entityHeader)).read();
      if (ionField(encoding, 410) !== 0 || ionField(encoding, 411) !== 0) return fail("不支持压缩或加密的 KFX 实体");
      for (const [key, text] of titleMetadata(new IonReader(bytes.subarray(entityHeader)).read())) {
        if ((key === "title" || key === "author") && !metadata.has(key)) metadata.set(key, text);
      }
    }
    return { title: metadata.get("title") ?? null, author: metadata.get("author") ?? null };
  } catch (error) {
    if (error instanceof KfxMetadataError) throw error;
    throw new KfxMetadataError("无法读取 KFX 书籍信息", { cause: error });
  }
}
