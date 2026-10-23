import { IonReader, ionField, type IonValue } from "../boko/kfx";

/** The KFX position map does not expose reader sections directly; a malformed or non-boko file is skipped. */
export class KfxPositionsError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "KfxPositionsError"; }
}
export interface KindleChapter { index: number; startPid: number; endPid: number; eids: Set<number>; cover: boolean }
export interface KindlePositions { chapters: KindleChapter[]; totalPid: number; sectionCount: number }
const fail = (message: string): never => { throw new KfxPositionsError(message); };
const symbolId = (value: IonValue): number | null => value !== null && typeof value === "object" && "symbol" in value ? value.symbol : null;
const integer = (value: IonValue, name: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fail(`无效的 KFX ${name}`);
  return value;
};
function symbolNames(table: IonValue): Array<string | null> {
  const imports = ionField(table, 6), locals = ionField(table, 7);
  let maxId = 0;
  if (!Array.isArray(imports) || !Array.isArray(locals)) return fail("KFX 缺少文档符号表");
  for (const entry of imports) maxId = Math.max(maxId, integer(ionField(entry, 8), "符号表导入"));
  const names: Array<string | null> = [null];
  for (let id = 1; id <= maxId; id++) names.push(null);
  for (const value of locals) names.push(typeof value === "string" ? value : null);
  // boko's local symbols start after YJ_symbols; the first names are s0, c0, c1, …, story_c0, …
  if (!locals.length) return fail("KFX 文档符号表为空");
  return names;
}
interface EntityRecord { id: number; type: number; offset: number; size: number }

/** Reads only the container header, symbol table, index and the position/section entities. */
export async function readKfxPositions(file: Blob): Promise<KindlePositions> {
  const read = async (start: number, length: number): Promise<Uint8Array> => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > file.size) return fail("KFX 容器被截断");
    const bytes = new Uint8Array(await file.slice(start, start + length).arrayBuffer());
    if (bytes.length !== length) return fail("KFX 容器被截断");
    return bytes;
  };
  const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    const headerBytes = await read(0, 18);
    if (new TextDecoder().decode(headerBytes.subarray(0, 4)) !== "CONT") return fail("无效的 KFX 容器");
    const header = view(headerBytes), headerLength = header.getUint32(6, true);
    if (header.getUint16(4, true) !== 2 || headerLength < 18) return fail("不支持的 KFX 容器版本");
    const info = new IonReader(await read(header.getUint32(10, true), header.getUint32(14, true))).read();
    if (ionField(info, 410) !== 0 || ionField(info, 411) !== 0) return fail("不支持压缩或加密的 KFX");
    const indexStart = integer(ionField(info, 413), "索引偏移"), indexLength = integer(ionField(info, 414), "索引长度");
    if (!indexLength || indexLength % 24 || indexStart < 18 || indexStart + indexLength > headerLength) return fail("无效的 KFX 索引");
    const symbolStart = integer(ionField(info, 415), "符号表偏移"), symbolLength = integer(ionField(info, 416), "符号表长度");
    symbolNames(new IonReader(await read(symbolStart, symbolLength)).read());
    const index = await read(indexStart, indexLength), indexView = view(index), records: EntityRecord[] = [];
    for (let at = 0; at < indexLength; at += 24) {
      const id = indexView.getUint32(at, true), type = indexView.getUint32(at + 4, true);
      const relative = indexView.getBigUint64(at + 8, true), size = indexView.getBigUint64(at + 16, true);
      if (relative > BigInt(Number.MAX_SAFE_INTEGER) || size > BigInt(Number.MAX_SAFE_INTEGER) || ![260, 264, 265].includes(type)) continue;
      const offset = headerLength + Number(relative);
      if (size < 10n || offset < headerLength || offset + Number(size) > file.size) return fail("无效的 KFX 实体");
      records.push({ id, type, offset, size: Number(size) });
    }
    const entity = async ({ type, offset, size }: EntityRecord): Promise<IonValue> => {
      const bytes = await read(offset, size), data = view(bytes), entityHeader = data.getUint32(6, true);
      if (size < 10 || new TextDecoder().decode(bytes.subarray(0, 4)) !== "ENTY" || entityHeader < 10 || entityHeader >= size) return fail("无效的 KFX 实体");
      const encoding = new IonReader(bytes.subarray(10, entityHeader)).read();
      if (ionField(encoding, 410) !== 0 || ionField(encoding, 411) !== 0) return fail("不支持压缩或加密的 KFX 实体");
      return new IonReader(bytes.subarray(entityHeader)).read();
    };
    const sections = new Map<number, { cover: boolean }>(), pidByEid = new Map<number, number>();
    let positionMap: IonValue | null = null;
    for (const record of records) {
      const value = await entity(record);
      if (record.type === 260) {
        const symbol = symbolId(ionField(value, 174)), pages = ionField(value, 141);
        if (symbol === null || !Array.isArray(pages) || !pages.length || sections.has(symbol)) return fail("无效的 KFX 章节");
        sections.set(symbol, { cover: pages.every(page => symbolId(ionField(page, 159)) === 270) });
      } else if (record.type === 264) positionMap = value;
      else {
        for (const entry of Array.isArray(value) ? value : []) {
          const eid = integer(ionField(entry, 185), "位置 eid"), pid = integer(ionField(entry, 184), "位置 pid");
          if (pidByEid.has(eid) && pidByEid.get(eid) !== pid) return fail("KFX 位置映射冲突");
          pidByEid.set(eid, pid);
        }
      }
    }
    if (!sections.size || !positionMap || !Array.isArray(positionMap)) return fail("KFX 缺少章节或位置映射");
    // The position map is in boko's reading order, including the cover section.
    const ordered: Array<{ cover: boolean; eids: Set<number> }> = [], seen = new Set<number>();
    for (const entry of positionMap) {
      const symbol = symbolId(ionField(entry, 174)), info = symbol === null ? undefined : sections.get(symbol), raw = ionField(entry, 181);
      if (symbol === null || !info || seen.has(symbol) || !Array.isArray(raw)) return fail("KFX 章节顺序无效");
      seen.add(symbol);
      ordered.push({ cover: info.cover, eids: new Set(raw.map(eid => integer(eid, "章节 eid"))) });
    }
    if (seen.size !== sections.size || !pidByEid.size) return fail("KFX 章节顺序无效");
    let largestPid = 0;
    for (const pid of pidByEid.values()) largestPid = Math.max(largestPid, pid);
    const totalPid = largestPid + 1, chapters: KindleChapter[] = ordered.map((section, index) => {
      const pids = [...section.eids].map(eid => pidByEid.get(eid)).filter((pid): pid is number => pid !== undefined);
      return { index, startPid: pids.length ? Math.min(...pids) : 0, endPid: 0, eids: section.eids, cover: section.cover };
    });
    for (let index = 0; index < chapters.length; index++) chapters[index]!.endPid = index + 1 < chapters.length ? chapters[index + 1]!.startPid : totalPid;
    return { chapters, totalPid, sectionCount: chapters.length };
  } catch (error) {
    if (error instanceof KfxPositionsError) throw error;
    throw new KfxPositionsError("无法读取 KFX 阅读位置", { cause: error });
  }
}
const clamp = (value: number) => Math.max(0, Math.min(1, value));
export function kindlePosition(positions: KindlePositions, decoded: { eid: number; pid: number }): { chapter: number | null; chapter_fraction: number | null; percent: number } {
  const chapter = positions.chapters.find(item => item.eids.has(decoded.eid));
  const percent = positions.totalPid > 0 ? Math.max(0, Math.min(100, decoded.pid / positions.totalPid * 100)) : 0;
  if (!chapter) return { chapter: null, chapter_fraction: null, percent };
  const span = chapter.endPid - chapter.startPid;
  return { chapter: chapter.index, chapter_fraction: chapter.cover ? 0 : span > 0 ? clamp((decoded.pid - chapter.startPid) / span) : 0, percent };
}
