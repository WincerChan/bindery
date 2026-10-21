import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { bookFromDict, bookToDict, metadataFromDict } from "../src/core/models";
import type { BookData, Metadata } from "../src/core/models";
import {
  decodeText,
  parseBook,
  parseBookBytes,
  parseBookByteEvents,
  textHasContent,
} from "../src/core/parsing";
import type { ParsedBookEvent } from "../src/core/parsing";
import {
  ruleTemplateFromData,
  validateRuleTemplateJson,
} from "../src/core/rules";
import { composeCss, themeTemplateFromData } from "../src/core/themes";
import {
  buildEpub,
  buildEpubFromSectionStream,
  epubBaseHref,
  extractCover,
  extractEpubMetadata,
  iterEpubSectionDocuments,
  listEpubSections,
  loadEpubItem,
  normalizeEpubArchivePaths,
  stripWebpAssetsAndRefs,
  updateEpubMetadata,
} from "../src/core/epub";
import type { EpubSection, StreamBuildSection } from "../src/core/epub";
import { readArchive } from "../src/core/archive";
import {
  parseBookFile,
  parseBookFileEvents,
  textFileHasContent,
} from "../src/server/parsing";

interface Inspection {
  metadata: ReturnType<typeof extractEpubMetadata>;
  sections: EpubSection[];
  documents: {
    index: number;
    title: string;
    item_path: string;
    content_sha256: string;
    media_type: string;
  }[];
  cover: [string, string] | null;
  loaded: {
    item_path: string;
    base: string;
    content_sha256: string;
    media_type: string;
  }[];
}
interface Build {
  file: string;
  mode: string;
  meta: Metadata;
  css: string | null;
  cover: string | null;
  inspection: Inspection;
}
interface Case {
  name: string;
  file: string;
  rule: string;
  decoded: string;
  book: BookData;
  text_book: BookData;
  events: ParsedBookEvent[];
  has_content: boolean;
  builds: Build[];
}
interface PatchVariant {
  kind: string;
  file: string;
  options?: {
    cover_path?: string;
    css_text?: string;
    strip_original_css?: boolean;
    strip_webp_assets?: boolean;
  };
  changed?: boolean;
  inspection: Inspection;
}
interface Reference {
  cases: Case[];
  rules: Record<string, Record<string, unknown>>;
  themes: Record<string, unknown>[];
  patch_meta: Metadata;
  patches: {
    input: string;
    inspection: Inspection;
    variants: PatchVariant[];
  }[];
  library_copies: number;
  epubs: Record<string, { name: string; sha256: string }[]>;
}
const fixtures = resolve("tests-ts/fixtures");
const inputs = resolve("tests-ts/fixtures/parity/core/inputs");
const reference = JSON.parse(
  gunzipSync(
    readFileSync(
      resolve("tests-ts/fixtures/parity/core/reference.json.gz"),
    ),
  ).toString("utf8"),
) as Reference;
const bytes = (file: string) => new Uint8Array(readFileSync(resolve(inputs, file)));
const coverAsset = (name: string | null | undefined) =>
  name
    ? { name, data: new Uint8Array(readFileSync(resolve(fixtures, name))) }
    : null;
function normalized(data: Uint8Array, name: string): Uint8Array {
  if (!name.toLowerCase().endsWith(".opf")) return data;
  // The sole content normalization is the runtime-generated dcterms:modified value.
  const text = Buffer.from(data)
    .toString("latin1")
    .replace(
      /(\bproperty=["']dcterms:modified["'][^>]*>)[^<]*(<\/)/g,
      "$1__MODIFIED__$2",
    );
  return new Uint8Array(Buffer.from(text, "latin1"));
}
function compareEpub(actual: Uint8Array, expectedFile: string): void {
  const members = readArchive(actual),
    expectedMembers = reference.epubs[expectedFile];
  expect(members.map((m) => m.name)).toEqual(
    expectedMembers.map((m) => m.name),
  );
  expect(members[0]?.name).toBe("mimetype");
  for (const zip of [actual]) {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0);
    expect(
      new TextDecoder().decode(zip.subarray(30, 30 + view.getUint16(26, true))),
    ).toBe("mimetype");
  }
  expect(new TextDecoder().decode(members[0].data)).toBe(
    "application/epub+zip",
  );
  for (let i = 0; i < members.length; i++) {
    const a = normalized(members[i].data, members[i].name);
    expect(
      createHash("sha256").update(a).digest("hex"),
      `${expectedFile}: ${members[i].name} legacy digest`,
    ).toBe(expectedMembers[i].sha256);
  }
}
function compareInspection(data: Uint8Array, expected: Inspection): void {
  expect(extractEpubMetadata(data, "fallback")).toEqual(expected.metadata);
  expect(listEpubSections(data)).toEqual(expected.sections);
  expect(
    [...iterEpubSectionDocuments(data)].map((d) => ({
      index: d.index,
      title: d.title,
      item_path: d.item_path,
      content_sha256: createHash("sha256").update(d.content).digest("hex"),
      media_type: d.media_type,
    })),
  ).toEqual(expected.documents);
  const cover = extractCover(data);
  expect(
    cover ? [Buffer.from(cover[0]).toString("base64"), cover[1]] : null,
  ).toEqual(expected.cover);
  for (const entry of expected.loaded) {
    const base = epubBaseHref("/book/parity/epub", entry.item_path);
    expect(base).toBe(entry.base);
    const [content, media] = loadEpubItem(data, entry.item_path, base);
    expect(media).toBe(entry.media_type);
    expect(createHash("sha256").update(content).digest("hex")).toBe(
      entry.content_sha256,
    );
  }
}

describe("legacy rules and theme parity", () => {
  for (const filename of readdirSync("bindery-templates/rules").filter((f) =>
    f.endsWith(".json"),
  ))
    it(filename, () => {
      const id = filename.replace(/\.json$/, ""),
        raw = readFileSync(
          resolve("bindery-templates/rules", filename),
          "utf8",
        );
      expect(validateRuleTemplateJson(id, raw)).toEqual(reference.rules[id]);
    });
  for (const theme of reference.themes)
    it(`theme ${String(theme.id)}`, () => {
      const loaded = themeTemplateFromData(theme, `${String(theme.id)}.json`);
      expect(loaded.css).toBe(String(theme.css).trimEnd());
      expect(composeCss(loaded.css, "  p { color: #123; }\n")).toBe(
        String(theme.css).trim() + "\n\np { color: #123; }",
      );
    });
});
for (const fixture of reference.cases)
  describe(`${fixture.name} / ${fixture.rule}`, () => {
    const data = new Uint8Array(readFileSync(resolve(fixtures, fixture.file)));
    const rules = ruleTemplateFromData(
      reference.rules[fixture.rule],
      fixture.rule + ".json",
    ).rules;
    it("decodes and parses text, bytes, streaming events and model roundtrip", () => {
      expect(decodeText(data)).toBe(fixture.decoded);
      expect(bookToDict(parseBookBytes(data, fixture.name, rules))).toEqual(
        fixture.book,
      );
      expect(
        bookToDict(parseBook(decodeText(data), fixture.name, rules)),
      ).toEqual(fixture.text_book);
      expect([...parseBookByteEvents(data, fixture.name, rules)]).toEqual(
        fixture.events,
      );
      expect(textHasContent(data)).toBe(fixture.has_content);
      expect(bookToDict(bookFromDict(fixture.book))).toEqual(fixture.book);
      expect(
        bookToDict(
          parseBookFile(resolve(fixtures, fixture.file), fixture.name, rules),
        ),
      ).toEqual(fixture.book);
      expect([
        ...parseBookFileEvents(
          resolve(fixtures, fixture.file),
          fixture.name,
          rules,
        ),
      ]).toEqual(fixture.events);
      expect(textFileHasContent(resolve(fixtures, fixture.file))).toBe(
        fixture.has_content,
      );
    });
    for (const build of fixture.builds)
      it(build.file, () => {
        const book = parseBookBytes(data, fixture.name, rules),
          meta = metadataFromDict(build.meta);
        const options = { cover: coverAsset(build.cover), css_text: build.css };
        const actual =
          build.mode === "book"
            ? buildEpub(book, meta, options)
            : buildEpubFromSectionStream({
                ...options,
                meta,
                source_author: book.author,
                source_intro: book.intro,
                stream_sections: [
                  ...parseBookByteEvents(data, fixture.name, rules),
                ].filter(
                  (e): e is Extract<ParsedBookEvent, { kind: string }> =>
                    "kind" in e,
                ) as StreamBuildSection[],
              });
        compareEpub(actual, build.file);
        compareInspection(actual, build.inspection);
      });
  });
for (const patch of reference.patches)
  describe(`EPUB ${patch.input}`, () => {
    it("reads original metadata, cover, TOC, spine documents and preview", () =>
      compareInspection(bytes(patch.input), patch.inspection));
    for (const variant of patch.variants)
      it(variant.kind, () => {
        const input = bytes(patch.input);
        let actual: Uint8Array;
        if (variant.kind === "strip-webp" || variant.kind === "normalize") {
          const result =
            variant.kind === "strip-webp"
              ? stripWebpAssetsAndRefs(input)
              : normalizeEpubArchivePaths(input);
          expect(result.changed).toBe(variant.changed);
          actual = result.data;
        } else {
          const options = {
            ...variant.options,
            cover: coverAsset(variant.options?.cover_path),
          };
          actual = updateEpubMetadata(input, reference.patch_meta, options);
          if (variant.kind === "repeat-css")
            actual = updateEpubMetadata(actual, reference.patch_meta, options);
        }
        compareEpub(actual, variant.file);
        compareInspection(actual, variant.inspection);
      });
  });
