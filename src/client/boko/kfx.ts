/** Minimal bounds-checked Ion binary reader for boko's uncompressed KFX containers.
 * Numeric field IDs are the KFX YJ symbol IDs; no string/regex scanning of binary data.
 */
export type IonValue = null | boolean | number | string | Uint8Array | IonValue[] | { fields: Array<[number, IonValue]> } | { symbol: number };
export function ionFields(value: IonValue): Array<[number, IonValue]> { return value !== null && typeof value === "object" && "fields" in value ? value.fields : []; }
export const ionField = (value: IonValue, id: number): IonValue => ionFields(value).find(([key]) => key === id)?.[1] ?? null;
export class IonReader {
  private at = 0;
  constructor(private bytes: Uint8Array) {}
  private take(n: number) {
    if (!Number.isSafeInteger(n) || n < 0 || this.at + n > this.bytes.length) throw new Error("KFX Ion 数据被截断");
    const out = this.bytes.subarray(this.at, this.at + n); this.at += n; return out;
  }
  private varUInt() {
    let n = 0;
    for (let i = 0; i < 8; i++) { const b = this.take(1)[0]; n = n * 128 + (b & 127); if (!Number.isSafeInteger(n)) break; if (b & 128) return n; }
    throw new Error("KFX Ion 整数溢出");
  }
  private uint(bytes: Uint8Array) { let n = 0; for (const b of bytes) n = n * 256 + b; if (!Number.isSafeInteger(n)) throw new Error("KFX Ion 整数溢出"); return n; }
  read(depth = 0): IonValue {
    if (depth > 64) throw new Error("KFX Ion 嵌套过深");
    if (this.bytes[this.at] === 0xe0) {
      const marker = this.take(4); if (marker[1] !== 1 || marker[2] !== 0 || marker[3] !== 0xea) throw new Error("不支持的 Ion 版本");
    }
    const descriptor = this.take(1)[0], type = descriptor >> 4, nibble = descriptor & 15;
    if (nibble === 15) return null;
    if (type === 1) { if (nibble > 1) throw new Error("无效的 Ion 布尔值"); return nibble === 1; }
    const length = nibble === 14 ? this.varUInt() : type === 13 && nibble === 1 ? this.varUInt() : nibble;
    const end = this.at + length;
    if (end > this.bytes.length) throw new Error("KFX Ion 数据被截断");
    if (type === 14) {
      const annotationsLength = this.varUInt(); this.take(annotationsLength);
      const value = this.read(depth + 1); if (this.at !== end) throw new Error("无效的 Ion 注解"); return value;
    }
    if (type === 11 || type === 12 || type === 13) {
      const items: IonValue[] = [], fields: Array<[number, IonValue]> = [];
      while (this.at < end) {
        const key = type === 13 ? this.varUInt() : 0, value = this.read(depth + 1);
        if (type === 13) fields.push([key, value]); else items.push(value);
      }
      if (this.at !== end) throw new Error("无效的 Ion 容器长度");
      return type === 13 ? { fields } : items;
    }
    const payload = this.take(length);
    switch (type) {
      case 0: return null;
      case 2: return this.uint(payload);
      case 3: return -this.uint(payload);
      case 4: {
        if (!length) return 0;
        const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        if (length === 4) return view.getFloat32(0); if (length === 8) return view.getFloat64(0);
        throw new Error("无效的 Ion 浮点数");
      }
      case 5: {
        if (!length) return 0;
        let at = 0, b = payload[at++], exponent = b & 63; const negative = !!(b & 64);
        while (!(b & 128)) { if (at >= length) throw new Error("无效的 Ion 十进制数"); b = payload[at++]; exponent = exponent * 128 + (b & 127); }
        const coefficient = payload.slice(at), minus = !!(coefficient[0] & 128); if (coefficient.length) coefficient[0] &= 127;
        return (minus ? -1 : 1) * this.uint(coefficient) * 10 ** (negative ? -exponent : exponent);
      }
      case 7: return { symbol: this.uint(payload) };
      case 8: return new TextDecoder("utf-8", { fatal: true }).decode(payload);
      case 6: case 9: case 10: return payload;
      default: throw new Error("不支持的 KFX Ion 类型");
    }
  }
}
export interface KfxEntity { id: number; type: number; value: IonValue }
export function parseKfxEntities(data: Uint8Array, types?: readonly number[]): KfxEntity[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const range = (at: number, length: number) => {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(length) || at < 0 || length < 0 || at + length > data.length) throw new Error("KFX 容器被截断");
    return data.subarray(at, at + length);
  };
  const magic = (at: number) => new TextDecoder().decode(range(at, 4));
  if (data.length < 18 || magic(0) !== "CONT") throw new Error("无效的 KFX 容器");
  if (view.getUint16(4, true) !== 2) throw new Error("不支持的 KFX 容器版本");
  const header = view.getUint32(6, true); range(0, header);
  const info = new IonReader(range(view.getUint32(10, true), view.getUint32(14, true))).read();
  if (ionField(info, 410) !== 0 || ionField(info, 411) !== 0) throw new Error("不支持压缩或加密的 KFX");
  const start = ionField(info, 413), length = ionField(info, 414);
  if (typeof start !== "number" || typeof length !== "number" || length % 24 || start < 18 || start + length > header) throw new Error("无效的 KFX 索引");
  range(start, length);
  const result: KfxEntity[] = [];
  for (let pos = start; pos < start + length; pos += 24) {
    const id = view.getUint32(pos, true), type = view.getUint32(pos + 4, true);
    const offset = header + Number(view.getBigUint64(pos + 8, true)), size = Number(view.getBigUint64(pos + 16, true));
    range(offset, size);
    if (types && !types.includes(type)) continue;
    if (size < 10 || magic(offset) !== "ENTY") throw new Error("无效的 KFX 实体");
    const entityHeader = view.getUint32(offset + 6, true);
    if (entityHeader < 10 || entityHeader >= size) throw new Error("无效的 KFX 实体头");
    const encoding = new IonReader(range(offset + 10, entityHeader - 10)).read();
    if (ionField(encoding, 410) !== 0 || ionField(encoding, 411) !== 0) throw new Error("不支持压缩或加密的 KFX 实体");
    // Raw resource entities have image/font bytes rather than Ion payloads.
    const payload = range(offset + entityHeader, size - entityHeader);
    result.push({ id, type, value: type === 417 || type === 418 ? payload : new IonReader(payload).read() });
  }
  return result;
}
export function walkIon(value: IonValue, visit: (value: IonValue) => void): void {
  visit(value);
  if (Array.isArray(value)) for (const child of value) walkIon(child, visit);
  else for (const [, child] of ionFields(value)) walkIon(child, visit);
}
export interface KfxIdentity { contentId: string; cdeContentType: "EBOK" | "PDOC"; asin: string }
export function readKfxIdentity(data: Uint8Array): KfxIdentity {
  const entries = new Map<string, string>();
  for (const entity of parseKfxEntities(data, [490])) walkIon(entity.value, value => {
    const key = ionField(value, 492), text = ionField(value, 307);
    if (typeof key === "string" && typeof text === "string") {
      if (entries.has(key) && entries.get(key) !== text) throw new Error(`KFX 元数据冲突：${key}`);
      entries.set(key, text);
    }
  });
  const contentId = entries.get("content_id"), cdeContentType = entries.get("cde_content_type"), asin = entries.get("ASIN");
  if (!contentId || !/^[A-Za-z0-9_-]{1,128}$/.test(contentId) || (cdeContentType !== "EBOK" && cdeContentType !== "PDOC") || !asin || asin !== contentId) throw new Error("KFX 缺少可用于缩略图的 content_id / ASIN / cde_content_type");
  return { contentId, cdeContentType, asin };
}
