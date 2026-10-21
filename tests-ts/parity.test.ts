import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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

interface LocalCache {
  version: number;
  source: {
    bindery_db_sha256: string;
    books: { path: string; size: number; sha256: string }[];
  };
  library_copies: number;
  patches: { input: string; inspection: any; variants: any[] }[];
  epubs: Record<string, { names: any; sha256: string[] }>;
  blobs: Record<string, any>;
}
const localRoot = resolve(process.env.BINDERY_LOCAL_PARITY_DIR || ".parity-local");
const libraryRoot = resolve("library");
const libraryExists = existsSync(libraryRoot);
const digestBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function localEpubs(): { path: string; size: number }[] {
  if (!libraryExists) return [];
  return readdirSync(libraryRoot, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".epub"))
    .map(entry => {
      const path = join(entry.parentPath, entry.name);
      return { path: path.slice(libraryRoot.length + 1), size: statSync(path).size };
    })
    .sort((a, b) => a.size - b.size || a.path.localeCompare(b.path));
}
const localBooks = localEpubs();
let localSourceBooks: string[] = [];
let localSkipReason: string | null = null;
if (libraryExists) {
  const cachePath = join(localRoot, "core", "reference.json.gz");
  let cache: LocalCache | null = null;
  if (!existsSync(cachePath)) localSkipReason = `Local Python reference missing: ${cachePath}`;
  else {
    try { cache = JSON.parse(gunzipSync(readFileSync(cachePath)).toString("utf8")) as LocalCache; }
    catch (error) { localSkipReason = `Cannot read local Python reference ${cachePath}: ${String(error)}`; }
  }
  if (cache) {
    const recorded = cache.source.books;
    const booksMatch = localBooks.length >= recorded.length && recorded.every((book, index) => {
      const current = localBooks[index];
      return current.path === book.path && current.size === book.size && digestBytes(readFileSync(join(libraryRoot, book.path))) === book.sha256;
    });
    if (cache.version !== 1) localSkipReason = `Unsupported local Python reference version in ${cachePath}`;
    else if (cache.patches.length !== recorded.length) localSkipReason = `Local Python reference in ${cachePath} is incomplete`;
    // Only the two selected EPUBs feed these cases; bindery.db changes on every login and is not an input.
    else if (!booksMatch) localSkipReason = `Local library EPUB selection changed since ${cachePath} was recorded`;
    else {
      const deref = (value: unknown) => value && typeof value === "object" && "$blob" in value ? cache!.blobs[String((value as { $blob: string }).$blob)] : value;
      const expandInspection = (inspection: any): Inspection => ({
        ...inspection,
        sections: deref(inspection.sections),
        documents: deref(inspection.documents),
        cover: deref(inspection.cover),
      });
      const patches = cache.patches.map(patch => ({
        ...patch,
        inspection: expandInspection(patch.inspection),
        variants: patch.variants.map(variant => ({ ...variant, inspection: expandInspection(variant.inspection) })),
      }));
      const epubs = Object.fromEntries(Object.entries(cache.epubs).map(([file, value]) => {
        const names = deref(value.names) as string[];
        return [file, names.map((name, index) => ({ name, sha256: value.sha256[index] }))];
      }));
      reference.patches.push(...patches);
      Object.assign(reference.epubs, epubs);
      reference.library_copies = cache.library_copies;
      localSourceBooks = recorded.map(book => join(libraryRoot, book.path));
    }
  }
  if (localSkipReason) {
    console.warn(`[parity] Skipping local library EPUB comparisons: ${localSkipReason}`);
    const variants = ["metadata", "css", "clear-overlay", "strip-css", "replace-css", "cover", "combined", "repeat-css", "strip-webp", "normalize"];
    const placeholder = () => ({
      metadata: {} as Inspection["metadata"],
      sections: [],
      documents: [],
      cover: null,
      loaded: [],
    });
    reference.patches.push(...[0, 1].map(index => ({
      input: `input-library-${index}.epub`,
      inspection: placeholder(),
      variants: variants.map(kind => ({ kind, file: `input-library-${index}-${kind}.epub`, inspection: placeholder() })),
    })));
  }
}
const bytes = (file: string) => {
  if (file.startsWith("input-library-")) {
    const index = Number(/^input-library-(\d+)\.epub$/.exec(file)?.[1]);
    if (!localSourceBooks[index]) throw new Error(`Missing local library source for ${file}`);
    return new Uint8Array(readFileSync(localSourceBooks[index]));
  }
  return new Uint8Array(readFileSync(resolve(inputs, file)));
};
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
  describe(`EPUB ${patch.input}${patch.input.startsWith("input-library-") && localSkipReason ? ` (skipped: ${localSkipReason})` : ""}`, () => {
    const local = patch.input.startsWith("input-library-");
    const run = (name: string, fn: () => void) =>
      it(name, (ctx) => {
        if (local && localSkipReason) { console.warn(`[parity] ${localSkipReason}`); ctx.skip(localSkipReason); return; }
        fn();
      });
    run("reads original metadata, cover, TOC, spine documents and preview", () =>
      compareInspection(bytes(patch.input), patch.inspection));
    for (const variant of patch.variants)
      run(variant.kind, () => {
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
