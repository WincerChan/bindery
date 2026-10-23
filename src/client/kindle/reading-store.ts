/** Kindle reader data store (`.yjf` / `.yjr`): big-endian typed values, objects named in place.
 * `0xfe` starts a named object, `0xff` ends it; there is no array type, objects carry the value lists.
 */
export type ReaderStoreValue = null | boolean | number | bigint | string | ReaderStoreObject;
export interface ReaderStoreObject { name: string | null; values: ReaderStoreValue[] }
export interface ReaderDataStore { version: bigint; values: ReaderStoreValue[]; fields: Map<string, ReaderStoreValue[]> }
const MAGIC = "00000000001aB126".toLowerCase();
export class ReaderDataStoreError extends Error {
  constructor(message: string) { super(message); this.name = "ReaderDataStoreError"; }
}
const fail = (message: string): never => { throw new ReaderDataStoreError(message); };
class Reader {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}
  private take(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.at + length > this.bytes.length) return fail("阅读记录数据被截断");
    const value = this.bytes.subarray(this.at, this.at + length); this.at += length; return value;
  }
  private uint(length: number): number { let value = 0; for (const byte of this.take(length)) value = value * 256 + byte; return value; }
  private int(length: number): number { const value = this.uint(length); return value >= 2 ** (length * 8 - 1) ? value - 2 ** (length * 8) : value; }
  private name(): string | null {
    if (this.take(1)[0]) return null;
    const length = this.uint(2);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(this.take(length)); }
    catch { return fail("阅读记录名称不是 UTF-8"); }
  }
  value(depth = 0): ReaderStoreValue {
    if (depth > 64) return fail("阅读记录嵌套过深");
    const type = this.take(1)[0];
    switch (type) {
      case 0x00: return this.take(1)[0] !== 0;
      case 0x01: return this.int(4);
      case 0x02: return BigInt.asIntN(64, BigInt(`0x${[...this.take(8)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`));
      case 0x03:
        if (this.take(1)[0]) return null;
        {
          const length = this.uint(2);
          try { return new TextDecoder("utf-8", { fatal: true }).decode(this.take(length)); }
          catch { return fail("阅读记录字符串不是 UTF-8"); }
        }
      case 0x04: {
        const data = this.take(8), view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        return view.getFloat64(0);
      }
      case 0x07: return this.take(1)[0];
      case 0xfe: {
        const name = this.name(), values: ReaderStoreValue[] = [];
        while (this.at < this.bytes.length && this.bytes[this.at] !== 0xff) values.push(this.value(depth + 1));
        if (this.at >= this.bytes.length) return fail("阅读记录对象没有结束标记");
        this.take(1);
        return { name, values };
      }
      default: return fail(`未知的阅读记录类型 0x${type.toString(16)}`);
    }
  }
  done() { return this.at === this.bytes.length; }
}
export function parseReaderDataStore(bytes: Uint8Array): ReaderDataStore {
  const hex = [...bytes.subarray(0, 8)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (bytes.length < 8 || hex !== MAGIC) throw new ReaderDataStoreError("不是 Kindle 阅读记录");
  const reader = new Reader(bytes.subarray(8)), version = reader.value(), count = reader.value();
  if (typeof version !== "bigint" || version !== 1n || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new ReaderDataStoreError("无效的阅读记录头");
  const values: ReaderStoreValue[] = [], fields = new Map<string, ReaderStoreValue[]>();
  for (let index = 0; index < count; index++) {
    const value = reader.value(); values.push(value);
    if (value !== null && typeof value === "object" && value.name !== null) fields.set(value.name, value.values);
  }
  if (!reader.done()) throw new ReaderDataStoreError("阅读记录尾部有多余数据");
  return { version, values, fields };
}
const base64 = (value: string): Uint8Array => Uint8Array.from(atob(value), character => character.charCodeAt(0));
export function decodeKindlePosition(value: string): { eid: number; offset: number; pid: number } {
  const match = /^([A-Za-z0-9+/]{12}):(\d+)$/.exec(value);
  if (!match) throw new ReaderDataStoreError("无效的 Kindle 阅读位置");
  let bytes: Uint8Array;
  try { bytes = base64(match[1]); } catch { throw new ReaderDataStoreError("无效的 Kindle 阅读位置"); }
  if (bytes.length !== 9 || bytes[0] !== 1) throw new ReaderDataStoreError("无效的 Kindle 阅读位置");
  const eid = bytes[1]! + bytes[2]! * 0x100 + bytes[3]! * 0x10000 + bytes[4]! * 0x1000000;
  const offset = bytes[5]! + bytes[6]! * 0x100 + bytes[7]! * 0x10000 + bytes[8]! * 0x1000000;
  const pid = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid < 0) throw new ReaderDataStoreError("无效的 Kindle 阅读位置");
  return { eid, offset, pid };
}
