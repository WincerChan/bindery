import { describe, expect, it } from "vitest";
import { inspectFont, listFonts, matchesFontLanguage } from "../src/client/devices/fonts";
import { fakeKindle } from "./support/fake-fs";

const CJK = [0x7684, 0x4e00, 0x662f, 0x4e2d], LATIN = [0x41, 0x42, 0x61];
const utf16 = (text: string) => { const out = new Uint8Array(text.length * 2), view = new DataView(out.buffer); for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i)); return out; };
function nameTable(family: string) {
  const text = utf16(family), out = new Uint8Array(6 + 12 + text.length), view = new DataView(out.buffer);
  view.setUint16(2, 1); view.setUint16(4, 18); [3, 1, 0x409, 1, text.length, 0].forEach((value, field) => view.setUint16(6 + field * 2, value));
  out.set(text, 18); return out;
}
/** Format 4: one segment per code point mapped through idDelta, then the 0xFFFF terminator. */
function cmap4(codes: number[]) {
  const sorted = [...codes].sort((a, b) => a - b), segments = sorted.length + 1, size = 16 + segments * 8, sub = new Uint8Array(size), view = new DataView(sub.buffer);
  view.setUint16(0, 4); view.setUint16(2, size); view.setUint16(6, segments * 2);
  [...sorted, 0xffff].forEach((code, i) => {
    view.setUint16(14 + i * 2, code); view.setUint16(16 + segments * 2 + i * 2, code);
    view.setInt16(16 + segments * 4 + i * 2, code === 0xffff ? 1 : ((i + 1 - code) << 16) >> 16);
  });
  return sub;
}
/** Format 12: one group per code point. */
function cmap12(codes: number[]) {
  const size = 16 + codes.length * 12, sub = new Uint8Array(size), view = new DataView(sub.buffer);
  view.setUint16(0, 12); view.setUint32(4, size); view.setUint32(12, codes.length);
  codes.forEach((code, i) => { view.setUint32(16 + i * 12, code); view.setUint32(20 + i * 12, code); view.setUint32(24 + i * 12, i + 1); });
  return sub;
}
function cmapTable(sub: Uint8Array, platform: number, encoding: number) {
  const out = new Uint8Array(12 + sub.length), view = new DataView(out.buffer);
  view.setUint16(2, 1); view.setUint16(4, platform); view.setUint16(6, encoding); view.setUint32(8, 12); out.set(sub, 12); return out;
}
function font(filename: string, family: string, cmap?: Uint8Array) {
  const tables = [...(cmap ? [["cmap", cmap] as const] : []), ["name", nameTable(family)] as const];
  let offset = 12 + tables.length * 16;
  const placed = tables.map(([tag, bytes]) => { const at = offset; offset += Math.ceil(bytes.length / 4) * 4; return { tag, bytes, at }; });
  const out = new Uint8Array(offset), view = new DataView(out.buffer);
  view.setUint32(0, 0x00010000); view.setUint16(4, tables.length);
  placed.forEach(({ tag, bytes, at }, i) => { out.set(new TextEncoder().encode(tag), 12 + i * 16); view.setUint32(20 + i * 16, at); view.setUint32(24 + i * 16, bytes.length); out.set(bytes, at); });
  return new File([out], filename);
}

describe("Chinese / English font detection", () => {
  it("reads the character map: Chinese characters make a Chinese font, whatever the file size or name", async () => {
    expect((await inspectFont(font("Wenkai.ttf", "LXGW WenKai", cmapTable(cmap4([...LATIN, ...CJK]), 3, 1)))).cjk).toBe(true);
    expect((await inspectFont(font("Song.ttf", "Song", cmapTable(cmap12([...LATIN, ...CJK]), 3, 10)))).cjk).toBe(true);
    expect((await inspectFont(font("Bookerly.ttf", "Bookerly", cmapTable(cmap4(LATIN), 3, 1)))).cjk).toBe(false);
    // A single stray character is not enough.
    expect((await inspectFont(font("Symbols.ttf", "Symbols", cmapTable(cmap4([...LATIN, 0x4e00]), 3, 1)))).cjk).toBe(false);
    expect((await inspectFont(font("Bare.ttf", "Bare"))).cjk).toBeUndefined();
  });
  it("filters families by language, counting unreadable maps as English", async () => {
    const fs = await fakeKindle();
    for (const file of [font("Wenkai.ttf", "LXGW WenKai", cmapTable(cmap4([...LATIN, ...CJK]), 3, 1)), font("Bookerly.ttf", "Bookerly", cmapTable(cmap4(LATIN), 3, 1)), font("Bare.ttf", "Bare")])
      await fs.write(`fonts/${file.name}`, new Uint8Array(await file.arrayBuffer()));
    const families = await listFonts(fs.root), names = (language: "all" | "cjk" | "latin") => families.filter(family => matchesFontLanguage(family, language)).map(family => family.name);
    expect(names("all")).toEqual(["Bare", "Bookerly", "LXGW WenKai"]);
    expect(names("cjk")).toEqual(["LXGW WenKai"]);
    expect(names("latin")).toEqual(["Bare", "Bookerly"]);
  });
});
