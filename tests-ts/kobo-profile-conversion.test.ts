import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readArchive, writeArchive } from "../src/core/archive";
import { convertToKepubAsync, kepubEntryBytes, readKepubZip } from "../src/core/kepub";
import { convertForKobo } from "../src/core/kobo-kepub";
import { EMPTY_SETTINGS, generateProfileCss } from "../src/client/devices/profiles";
import { assetEpub } from "./support/kindle-assets";

const fixture = new Uint8Array(readFileSync(new URL("./fixtures/parity/kepub/input-mixed.epub", import.meta.url)));
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const members = (data: Uint8Array) => new Map(readKepubZip(data).map(entry => [entry.name, decode(kepubEntryBytes(entry))]));
const profile = { id: "custom", name: "正文", builtIn: false, settings: { ...EMPTY_SETTINGS, marginX: -4.9, textIndent: 2 } };

describe("Kobo profile conversion", () => {
  it("keeps the plain and default-profile output byte-identical to the converter", async () => {
    const plain = await convertToKepubAsync(fixture);
    expect((await convertForKobo(fixture)).data).toEqual(plain.data);
    expect((await convertForKobo(fixture, { profile: { settings: EMPTY_SETTINGS, css: "" } })).data).toEqual(plain.data);
  });
  it("adds bindery-profile.css and links it from content documents", async () => {
    const output = (await convertForKobo(fixture, { profile: { settings: EMPTY_SETTINGS, css: generateProfileCss(profile) } })).data, entries = members(output);
    const css = [...entries].find(([name]) => name.endsWith("bindery-profile.css"));
    expect(css?.[1]).toBe(generateProfileCss(profile));
    const documents = [...entries].filter(([name]) => /\.x?html?$/i.test(name));
    expect(documents.some(([, text]) => text.includes("bindery-profile.css"))).toBe(true);
    expect(documents.filter(([name]) => !name.includes("kepubify-titlepage")).every(([, text]) => text.includes("bindery-profile.css"))).toBe(true);
  });
  it("strips fonts/images and appends the profile in one compressed KEPUB", async () => {
    const encode = (value: string) => new TextEncoder().encode(value);
    const input = writeArchive(readArchive(assetEpub()).map(entry => entry.name.endsWith("container.xml") ? { ...entry, data: encode(new TextDecoder().decode(entry.data).replace("<container ", '<container version="1.0" ')) } : entry));
    const output = (await convertForKobo(input, { profile: { settings: { ...EMPTY_SETTINGS, stripFonts: true, stripImages: true }, css: generateProfileCss(profile) } })).data;
    const entries = members(output), names = [...entries.keys()];
    expect(names.some(name => /\/Fonts\//.test(name))).toBe(false);
    expect(names.filter(name => /\/Images\//.test(name))).toEqual(["EPUB/Images/cover.png"]);
    expect(names.some(name => name.endsWith("bindery-profile.css"))).toBe(true);
    expect(readKepubZip(output).filter(entry => entry.name !== "mimetype" && entry.method === 0 && entry.uncompressedSize > 0)).toEqual([]);
  });
});
