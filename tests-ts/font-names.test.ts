import { describe, expect, it } from "vitest";
import { koboFamilyName, renameFontFamily } from "../src/core/font-names";
import { inspectFont, installFonts, listFonts } from "../src/client/devices/fonts";
import { detectDevice, pairDetectedDevice } from "../src/client/devices/identity";
import { pairDevice } from "../src/client/kindle/identity";
import { fakeKindle, fakeKobo } from "./support/fake-fs";

type NameRecord = [platform: number, encoding: number, language: number, id: number, text: string];
const utf16 = (text: string) => { const out = new Uint8Array(text.length * 2), view = new DataView(out.buffer); for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i)); return out; };
const checksum = (bytes: Uint8Array) => { const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4); padded.set(bytes); const view = new DataView(padded.buffer); let sum = 0; for (let i = 0; i < padded.length; i += 4) sum = (sum + view.getUint32(i)) >>> 0; return sum; };

/** A minimal sfnt with a head table, a name table and an opaque glyph table, checksums included. */
function font(records: NameRecord[]) {
  const strings = records.map(([platform, , , , text]) => platform === 1 ? new TextEncoder().encode(text) : utf16(text));
  const name = new Uint8Array(6 + records.length * 12 + strings.reduce((sum, bytes) => sum + bytes.length, 0)), nameView = new DataView(name.buffer);
  nameView.setUint16(2, records.length); nameView.setUint16(4, 6 + records.length * 12);
  let cursor = 0;
  records.forEach(([platform, encoding, language, id], index) => {
    [platform, encoding, language, id, strings[index].length, cursor].forEach((value, field) => nameView.setUint16(6 + index * 12 + field * 2, value));
    name.set(strings[index], 6 + records.length * 12 + cursor); cursor += strings[index].length;
  });
  const head = new Uint8Array(56); new DataView(head.buffer).setUint32(12, 0x5f0f3cf5);
  const glyf = Uint8Array.from({ length: 37 }, (_, i) => i * 7);
  const tables = [["glyf", glyf], ["head", head], ["name", name]] as const;
  let offset = 12 + tables.length * 16;
  const placed = tables.map(([tag, bytes]) => { const at = offset; offset += Math.ceil(bytes.length / 4) * 4; return { tag, bytes, at }; });
  const out = new Uint8Array(offset), view = new DataView(out.buffer);
  view.setUint32(0, 0x00010000); view.setUint16(4, tables.length);
  placed.forEach(({ tag, bytes, at }, index) => {
    out.set(new TextEncoder().encode(tag), 12 + index * 16);
    view.setUint32(16 + index * 16, checksum(bytes)); view.setUint32(20 + index * 16, at); view.setUint32(24 + index * 16, bytes.length);
    out.set(bytes, at);
  });
  view.setUint32(placed[1].at + 8, (0xb1b0afba - checksum(out)) >>> 0);
  return out;
}
function names(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength), tables = view.getUint16(4);
  const entries = Object.fromEntries(Array.from({ length: tables }, (_, i) => [String.fromCharCode(...data.subarray(12 + i * 16, 16 + i * 16)), { checksum: view.getUint32(16 + i * 16), offset: view.getUint32(20 + i * 16), length: view.getUint32(24 + i * 16) }]));
  const { offset } = entries.name, count = view.getUint16(offset + 2), strings = offset + view.getUint16(offset + 4);
  const records = Array.from({ length: count }, (_, i) => {
    const at = offset + 6 + i * 12, [platform, , language, id, size, start] = [0, 2, 4, 6, 8, 10].map(field => view.getUint16(at + field));
    const bytes = data.subarray(strings + start, strings + start + size);
    return `${platform}/${language.toString(16)}/${id}: ${platform === 1 ? new TextDecoder("macintosh").decode(bytes) : new TextDecoder("utf-16be").decode(bytes)}`;
  });
  return { entries, records };
}
const ZHUQUE: NameRecord[] = [
  [1, 0, 0, 1, "Zhuque Fangsong (technical preview)"],
  [3, 1, 0x409, 1, "Zhuque Fangsong (technical preview)"], [3, 1, 0x409, 2, "Regular"], [3, 1, 0x409, 4, "Zhuque Fangsong (technical preview) Regular"],
  [3, 1, 0x409, 6, "ZhuqueFangsong-Regular"], [3, 1, 0x409, 16, "Zhuque Fangsong (technical preview)"], [3, 1, 0x804, 16, "朱雀仿宋（预览测试版）"],
];

describe("Kobo-safe font family names", () => {
  it("keeps ASCII names Kobo can use and makes the rest a run of ASCII CSS identifiers", () => {
    for (const name of ["LXGW WenKai Screen", "TsangerJinKai03", "Source-Han_Serif"]) expect(koboFamilyName(name)).toBe(name);
    // Kobo shows "寒蝉端黑宋Pro" as "?????Pro": non-ASCII families use the PostScript name minus its style.
    expect(koboFamilyName("寒蝉端黑宋Pro", "ChillDuanHeiSongPro_Regular")).toBe("ChillDuanHeiSongPro");
    expect(koboFamilyName("霞鹜文楷 轻便版", "LXGWWenKaiLite-Bold")).toBe("LXGWWenKaiLite");
    expect(koboFamilyName("霞鹜文楷")).toBe("Font");
    expect(koboFamilyName("(beta)", "Beta-Regular")).toBe("Beta");
    expect(koboFamilyName("Zhuque Fangsong (technical preview)")).toBe("Zhuque Fangsong");
    expect(koboFamilyName("A&B Serif")).toBe("A B Serif");
    expect(koboFamilyName("Book 2")).toBe("Book2");
    expect(koboFamilyName("03 W04")).toBe("F03 W04");
    expect(koboFamilyName("(beta)")).toBe("Font");
  });

  it("sets every family and full name in all languages, appends the name table and keeps checksums valid", () => {
    const original = font(ZHUQUE), renamed = renameFontFamily(original, { family: "Zhuque Fangsong", full: "Zhuque Fangsong Regular" })!;
    expect(names(renamed).records).toEqual([
      "1/0/1: Zhuque Fangsong", "3/409/1: Zhuque Fangsong", "3/409/2: Regular", "3/409/4: Zhuque Fangsong Regular",
      "3/409/6: ZhuqueFangsong-Regular", "3/409/16: Zhuque Fangsong", "3/804/16: Zhuque Fangsong",
    ]);
    // Everything before the appended table is untouched apart from the directory and head checksum.
    const { entries } = names(renamed), before = names(original).entries;
    expect(entries.name.offset).toBeGreaterThanOrEqual(original.length);
    expect(renamed.subarray(before.glyf.offset, before.glyf.offset + before.glyf.length)).toEqual(original.subarray(before.glyf.offset, before.glyf.offset + before.glyf.length));
    expect(entries.name.checksum).toBe(checksum(renamed.subarray(entries.name.offset, entries.name.offset + entries.name.length)));
    expect(checksum(renamed)).toBe(0xb1b0afba);
    expect(renameFontFamily(font([[3, 1, 0x409, 1, "LXGW WenKai Screen"]]), { family: "LXGW WenKai Screen", full: "LXGW WenKai Screen Regular" })).toBeNull();
  });

  it("installs a Kobo font under a usable family and file name, and leaves Kindle fonts as they are", async () => {
    const kobo = await fakeKobo(), device = await pairDetectedDevice(kobo.root, await detectDevice(kobo.root), "libra2", "Libra");
    const file = new File([font(ZHUQUE)], "ZhuqueFangsong-Regular.ttf");
    const [installed] = await installFonts(device, [file]);
    expect(installed!.family).toBe("Zhuque Fangsong");
    const written = await kobo.bytes("fonts/Zhuque Fangsong-Regular.ttf");
    expect((await inspectFont(new File([written], "x.ttf"))).family).toBe("Zhuque Fangsong");
    expect((await listFonts(kobo.root, undefined, "kobo")).map(family => family.name)).toEqual(["Zhuque Fangsong"]);

    const chinese = new File([font([[1, 0, 0, 1, "_____Pro"], [3, 1, 0x409, 1, "寒蝉端黑宋Pro"], [3, 1, 0x409, 6, "ChillDuanHeiSongPro_Regular"], [3, 1, 0x409, 16, "寒蝉端黑宋Pro"]])], "寒蝉端黑宋Pro-Regular.otf");
    expect((await installFonts(device, [chinese]))[0]!.family).toBe("ChillDuanHeiSongPro");
    expect(names(await kobo.bytes("fonts/ChillDuanHeiSongPro-Regular.otf")).records).toEqual(["1/0/1: ChillDuanHeiSongPro", "3/409/1: ChillDuanHeiSongPro", "3/409/6: ChillDuanHeiSongPro_Regular", "3/409/16: ChillDuanHeiSongPro"]);

    const kindle = await fakeKindle(), kpw = await pairDevice(kindle.root, "KPW3", "Kindle");
    await installFonts(kpw, [file]);
    expect(await kindle.bytes("fonts/ZhuqueFangsong-Regular.ttf")).toEqual(new Uint8Array(await file.arrayBuffer()));
  });
});
