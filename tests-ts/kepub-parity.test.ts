import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { convertToKepub, convertToKepubAsync, kepubEntryBytes, readKepubZip } from "../src/core/kepub";

interface ReferenceMember { name: string; text?: string; sha256?: string; size?: number }
interface ReferenceInput { input: string; inputSha256: string; dummyTitlepage: boolean; members: ReferenceMember[] }
const reference = JSON.parse(readFileSync(new URL("./fixtures/parity/kepub/reference.json", import.meta.url), "utf8")) as {
  generator: { tool: string; version: string; sha256: string; date: string };
  normalization: string;
  inputs: ReferenceInput[];
};
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("KEPUB parity with kepubify v4.0.4", () => {
  it("freezes the reference provenance and normalization contract", () => {
    expect(reference.generator).toEqual({ tool: "kepubify", version: "4.0.4", sha256: "37d7628d26c5c906f607f24b36f781f306075e7073a6fe7820a751bb60431fc5", date: "2026-10-21" });
    expect(reference.normalization).toContain("Member order is sorted by name");
    expect(reference.inputs.map(input => input.input)).toEqual(["input-dummy.epub", "input-mixed.epub", "input-titlepage.epub"]);
  });

  it.each(reference.inputs.map(input => [input.input, input] as const))("matches every normalized member asynchronously for %s", async (name, expected) => {
    const input = new Uint8Array(readFileSync(new URL(`./fixtures/parity/kepub/${name}`, import.meta.url)));
    const sync = convertToKepub(input), actual = await convertToKepubAsync(input);
    expect([...readKepubZip(actual.data)].map(entry => [entry.name, sha256(kepubEntryBytes(entry))])).toEqual([...readKepubZip(sync.data)].map(entry => [entry.name, sha256(kepubEntryBytes(entry))]));
    expect(actual.stats.dummyTitlepage).toBe(expected.dummyTitlepage);
  });

  it.each(reference.inputs.map(input => [input.input, input] as const))("matches every normalized member for %s", (name, expected) => {
    const input = new Uint8Array(readFileSync(new URL(`./fixtures/parity/kepub/${name}`, import.meta.url)));
    expect(sha256(input)).toBe(expected.inputSha256);
    const result = convertToKepub(input);
    expect(result.stats.dummyTitlepage).toBe(expected.dummyTitlepage);
    const ours = new Map(readKepubZip(result.data).map(entry => [entry.name, entry]));
    expect([...ours.keys()].sort((a, b) => a.localeCompare(b))).toEqual(expected.members.map(member => member.name));
    for (const member of expected.members) {
      const entry = ours.get(member.name);
      expect(entry, member.name).toBeDefined();
      const bytes = kepubEntryBytes(entry!);
      if (member.text !== undefined) {
        const actual = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
        if (actual !== member.text) {
          let at = 0; while (at < actual.length && at < member.text.length && actual[at] === member.text[at]) at++;
          expect(actual.slice(at, at + 300), `${member.name} differs at ${at}`).toBe(member.text.slice(at, at + 300));
        }
        expect(actual, member.name).toBe(member.text);
      } else {
        expect(sha256(bytes), member.name).toBe(member.sha256);
        expect(bytes.byteLength, member.name).toBe(member.size);
      }
    }
  });
});
