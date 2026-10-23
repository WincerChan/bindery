import { readFileSync } from "node:fs";
import { convertEpub } from "../../src/client/boko/conversion";
import type { KindlePositions } from "../../src/client/kindle/kfx-positions";
import { readKfxPositions } from "../../src/client/kindle/kfx-positions";
import type { ReaderStoreValue } from "../../src/client/kindle/reading-store";
import { writeArchive } from "../../src/core/archive";

export const kindleWasm = readFileSync(new URL("../../vendor/boko/boko_bg.wasm", import.meta.url)), encoder = new TextEncoder();
const object = (name: string, values: ReaderStoreValue[]): ReaderStoreValue => ({ name, values });
const i64 = (value: bigint) => { const out = new Uint8Array(8); new DataView(out.buffer).setBigInt64(0, value); return [...out]; };
const value = (input: ReaderStoreValue): number[] => {
  if (input === null) return [0x03, 1];
  if (typeof input === "boolean") return [0x00, input ? 1 : 0];
  if (typeof input === "number") {
    if (Number.isInteger(input) && input >= -2147483648 && input <= 2147483647) { const out = new Uint8Array(4); new DataView(out.buffer).setInt32(0, input); return [0x01, ...out]; }
    const out = new Uint8Array(8); new DataView(out.buffer).setFloat64(0, input); return [0x04, ...out];
  }
  if (typeof input === "bigint") return [0x02, ...i64(input)];
  if (typeof input === "string") { const data = encoder.encode(input); return [0x03, 0, data.length >> 8 & 255, data.length & 255, ...data]; }
  return [0xfe, ...(input.name === null ? [1] : [0, input.name.length >> 8 & 255, input.name.length & 255, ...encoder.encode(input.name)]), ...input.values.flatMap(value), 0xff];
};
export function readerDataStore(values: ReaderStoreValue[]): Uint8Array {
  const count = new Uint8Array(4); new DataView(count.buffer).setUint32(0, values.length);
  return new Uint8Array([0, 0, 0, 0, 0, 0x1a, 0xb1, 0x26, 0x02, ...i64(1n), 0x01, ...count, ...values.flatMap(value)]);
}
export const lprStore = (location: string, when: bigint) => readerDataStore([object("lpr", [2, location, when])]);
export function positionString(eid: number, offset: number, pid: number) {
  const bytes = new Uint8Array([1, eid & 255, eid >>> 8 & 255, eid >>> 16 & 255, eid >>> 24 & 255, offset & 255, offset >>> 8 & 255, offset >>> 16 & 255, offset >>> 24 & 255]);
  return `${btoa(String.fromCharCode(...bytes))}:${pid}`;
}
const chapter = (number: number, body: string) => encoder.encode(`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>第${number}章</title></head><body><h1>第${number}章</h1><p>${body}</p></body></html>`);
export function miniEpub() {
  const bodies = ["甲甲甲甲甲甲甲甲甲甲", "乙乙乙乙乙乙乙乙乙乙", "丙丙丙丙丙丙丙丙丙丙"];
  const manifest = bodies.map((_, index) => `<item id="c${index}" href="Text/c${index}.xhtml" media-type="application/xhtml+xml"/>`).join("");
  const spine = bodies.map((_, index) => `<itemref idref="c${index}"/>`).join("");
  const opf = `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:kindle-reading-device-test</dc:identifier><dc:title>三章书</dc:title><dc:language>zh</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifest}</manifest><spine>${spine}</spine></package>`;
  const nav = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol>${bodies.map((_, index) => `<li><a href="Text/c${index}.xhtml">第${index + 1}章</a></li>`).join("")}</ol></nav></body></html>`;
  return writeArchive([
    { name: "mimetype", data: encoder.encode("application/epub+zip") },
    { name: "META-INF/container.xml", data: encoder.encode(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`) },
    { name: "OEBPS/content.opf", data: encoder.encode(opf) },
    { name: "OEBPS/nav.xhtml", data: encoder.encode(nav) },
    ...bodies.map((body, index) => ({ name: `OEBPS/Text/c${index}.xhtml`, data: chapter(index + 1, body) })),
  ]);
}
export async function miniKfx(): Promise<{ data: Uint8Array; positions: KindlePositions }> {
  const converted = await convertEpub(miniEpub(), kindleWasm);
  return { data: converted.data, positions: await readKfxPositions(new Blob([converted.data])) };
}
