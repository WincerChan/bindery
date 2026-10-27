import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { writeArchive } from "../src/core/archive";
import { countDocumentWords } from "../src/core/text";
import { CountArchive } from "../src/server/books/count-archive";
import { ReaderArchive } from "../src/server/reader/archive";
import { countEpubWords, extrapolateWordCount, MAX_DENSITY_CV, MIN_ESTIMATE_BYTES, sampleDensityCv, wordCountSampleIndices, wordCountSpine } from "../src/server/books/word-count-estimate";

vi.mock("node:zlib", async importOriginal => {
  const module = await importOriginal<typeof import("node:zlib")>();
  return { ...module, inflateRawSync: vi.fn(module.inflateRawSync) };
});
const roots: string[] = [], encode = (text: string) => new TextEncoder().encode(text);
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
interface Document { text: string; name?: string; properties?: string; linear?: string; guide?: string; semantic?: string; media?: string; inSpine?: boolean }
function fixture(documents: Document[]) {
  const root = mkdtempSync(join(tmpdir(), "bindery-count-estimate-")); roots.push(root);
  const path = join(root, "book.epub"), names = documents.map((doc, i) => doc.name ?? `doc${i}.xhtml`);
  const manifest = documents.map((doc, i) => `<item id="d${i}" href="${encodeURI(names[i])}" media-type="${doc.media ?? "application/xhtml+xml"}" properties="${doc.properties ?? ""}" ops:type="${doc.semantic ?? ""}"/>`).join("");
  const spine = documents.map((doc, i) => doc.inSpine === false ? "" : `<itemref idref="d${i}" linear="${doc.linear ?? "yes"}"/>`).join("");
  const guide = documents.map((doc, i) => doc.guide ? `<reference type="${doc.guide}" href="${encodeURI(names[i])}#start"/>` : "").join("");
  writeFileSync(path, writeArchive([
    { name: "META-INF/container.xml", data: encode('<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>') },
    { name: "OPS/book.opf", data: encode(`<package xmlns:ops="http://www.idpf.org/2007/ops"><metadata/><manifest>${manifest}</manifest><spine>${spine}</spine><guide>${guide}</guide></package>`) },
    ...documents.map((doc, i) => ({ name: `OPS/${names[i]}`, data: encode(doc.text) })),
  ]));
  return new CountArchive(path, statSync(path, { bigint: true }), () => {});
}
const prose = `<html><body><p>${"中文 ".repeat(20000)}</p></body></html>`;
const largeBook = () => Array.from({ length: 20 }, () => ({ text: prose }));

describe("sample arithmetic", () => {
  it.each([
    [0, []], [1, [0]], [4, [0, 1, 2, 3]], [10, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
    [11, [0, 1, 2, 3, 4, 6, 7, 8, 9, 10]], [20, [1, 3, 5, 7, 9, 11, 13, 15, 17, 19]],
    [2227, [111, 334, 556, 779, 1002, 1224, 1447, 1670, 1892, 2115]],
  ])("uses midpoint indices for %i documents", (n, expected) => expect(wordCountSampleIndices(n as number)).toEqual(expected));
  it("extrapolates the byte-weighted density, not the average of document densities", () => {
    const samples = [{ count: 10, bytes: 100 }, { count: 200, bytes: 1000 }];
    expect(extrapolateWordCount(10000, samples)).toBe(1909);
    expect(extrapolateWordCount(10000, [{ count: 0, bytes: 0 }])).toBe(0);
    expect(sampleDensityCv(samples)).toBeCloseTo(1 / 3);
    expect(sampleDensityCv([{ count: 1, bytes: 10 }, { count: 2, bytes: 20 }])).toBe(0);
    expect(sampleDensityCv([{ count: 0, bytes: 10 }])).toBe(Infinity);
    expect(sampleDensityCv([{ count: 1, bytes: 0 }])).toBe(Infinity);
  });
});

describe("indexed native EPUB counting", () => {
  it("reads only ten selected chapters plus container/OPF, never metadata/title discovery", () => {
    const archive = fixture(largeBook()), read = vi.spyOn(archive, "read");
    vi.spyOn(ReaderArchive.prototype, "metadata").mockImplementation(() => { throw new Error("must not discover titles"); });
    vi.mocked(zlib.inflateRawSync).mockClear();
    const result = countEpubWords(archive);
    expect(result).toMatchObject({ count: 800000, fallback: null, documents: 20, totalBytes: encode(prose).length * 20 });
    expect(result.densityCv).toBeCloseTo(0);
    expect(read.mock.calls.map(([name]) => name)).toEqual(["META-INF/container.xml", "OPS/book.opf", ...wordCountSampleIndices(20).map(i => `OPS/doc${i}.xhtml`)]);
    expect(zlib.inflateRawSync).toHaveBeenCalledTimes(12);
    expect(archive.stats.metadataParses).toBe(0);
  });
  it("excludes non-linear/non-document items, nav, guide and EPUB3 semantic landmarks from sizes and samples", () => {
    const excluded = "<p>excluded words 中文</p>";
    const archive = fixture([
      ...largeBook(),
      { text: excluded, guide: "toc", name: "contents.xhtml" },
      { text: excluded, guide: "cover" },
      { text: excluded, guide: "title-page" },
      { text: excluded, name: "front matter.xhtml" },
      { text: excluded, name: "jacket.xhtml" },
      { text: excluded, name: "navigation-target.xhtml" },
      { text: excluded, semantic: "toc" },
      { text: excluded, linear: "no" },
      { text: excluded, media: "image/svg+xml" },
      { text: excluded, inSpine: false },
      { properties: "nav", text: `<html xmlns:e="http://www.idpf.org/2007/ops"><body><nav e:type="landmarks"><a e:type="frontmatter titlepage" href="front%20matter.xhtml#start">Title</a><a e:type="cover" href="jacket.xhtml">Cover</a><a e:type="toc" href="navigation-target.xhtml">Contents</a><a e:type="bodymatter" href="doc0.xhtml">Beginning</a></nav><nav e:type="toc"><a href="doc1.xhtml">Keep this chapter</a></nav></body></html>` },
    ]);
    const read = vi.spyOn(archive, "read"), result = countEpubWords(archive);
    expect(result).toMatchObject({ count: 800000, documents: 20, fallback: null, totalBytes: encode(prose).length * 20 });
    expect(read.mock.calls.map(([name]) => name)).toEqual(["META-INF/container.xml", "OPS/book.opf", "OPS/doc30.xhtml", ...wordCountSampleIndices(20).map(i => `OPS/doc${i}.xhtml`)]);
  });
  it("excludes standalone document semantics on the exact path, including namespace aliases", () => {
    const content = "<html><body><p>real words</p></body></html>";
    const archive = fixture([
      { text: content },
      { text: '<html xmlns:e="http://www.idpf.org/2007/ops"><head><title>Title</title></head><body e:type="titlepage">Ignore these words</body></html>' },
      { text: '<html><body><section epub:type="cover">Ignore</section></body></html>' },
      { text: '<html><body><nav epub:type="toc">Ignore</nav></body></html>' },
    ]);
    expect(countEpubWords(archive)).toMatchObject({ count: 2, documents: 1, totalBytes: encode(content).length, fallback: "few-documents" });
  });
  it("recounts exactly if a sample reveals undeclared navigation semantics, removing its bytes", () => {
    const docs = largeBook(); docs[9] = { text: `<html><body epub:type="toc">${"目录 ".repeat(20000)}</body></html>` };
    expect(countEpubWords(fixture(docs))).toMatchObject({ count: 760000, documents: 19, totalBytes: encode(prose).length * 19, fallback: "uneven" });
  });
  it.each([0, 1, 10])("counts exactly when there are only %i documents", n => {
    const archive = fixture(Array.from({ length: n }, () => ({ text: prose + prose }))), read = vi.spyOn(archive, "read");
    expect(countEpubWords(archive)).toMatchObject({ count: n * 80000, fallback: "few-documents" });
    expect(read).toHaveBeenCalledTimes(n + 2);
  });
  it("counts small books exactly even with more than ten chapters", () => {
    const docs = Array.from({ length: 15 }, (_, i) => ({ text: `<p>${"word ".repeat(i + 1)}</p>` })), archive = fixture(docs);
    const result = countEpubWords(archive);
    expect(result).toMatchObject({ count: 120, fallback: "small", densityCv: null });
    expect(result.totalBytes).toBeLessThan(MIN_ESTIMATE_BYTES);
  });
  it.each([
    ["image-only", `<html><body><img src="data:image/png;base64,${"A".repeat(200000)}"/></body></html>`],
    ["long TOC-like", `<html><body>${`<a href="${"x".repeat(100)}">目</a>`.repeat(1600)}</body></html>`],
  ])("falls back for an unmarked %s document in the middle, reusing sampled counts", (_kind, text) => {
    const docs = largeBook(); docs[9] = { text };
    const archive = fixture(docs), read = vi.spyOn(archive, "read"), result = countEpubWords(archive);
    expect(result.fallback).toBe("uneven");
    expect(result.densityCv).toBeGreaterThan(MAX_DENSITY_CV);
    expect(result.count).toBe(docs.reduce((sum, doc) => sum + countDocumentWords(doc.text), 0));
    expect(read).toHaveBeenCalledTimes(22); // Each chapter once, including the original samples.
    expect(new Set(read.mock.calls.map(([name]) => name)).size).toBe(22);
  });
  it("falls back when all sample densities are zero, rather than estimating unseen prose as zero", () => {
    const docs = largeBook();
    for (const i of wordCountSampleIndices(docs.length)) docs[i] = { text: `<img alt="${"x".repeat(150000)}"/>` };
    const result = countEpubWords(fixture(docs));
    expect(result).toMatchObject({ count: 400000, fallback: "uneven", densityCv: Infinity });
  });
  it("can measure the exact reference using the same filtered population", () => {
    const archive = fixture(largeBook());
    expect(wordCountSpine(archive)).toHaveLength(20);
    expect(countEpubWords(archive, true)).toMatchObject({ count: 800000, fallback: "requested", densityCv: null });
  });
});
