import { linearSpineDocumentPaths, manifestFromOpf } from "../../core/epub";
import { decodeHtmlDocument } from "../../core/html-encoding";
import { HtmlTokenizer } from "../../core/html-tokenizer";
import { countDocumentWords } from "../../core/text";
import { attr, child, children, descendants, parseXml, type Element } from "../../core/xml";
import type { CountArchive } from "./count-archive";

export const WORD_COUNT_SAMPLES = 10;
export const MIN_ESTIMATE_BYTES = 2 * 1024 * 1024;
// Population CV of the ten document densities. Eight eligible local books measured
// 0.0137–0.0525 (the ninth is below 2 MiB). A middle image/long-TOC chapter in
// the 20-document synthetic tests gives >0.32. 0.20 leaves headroom for ordinary
// prose variation while rejecting those biased samples; it is not an error bound.
export const MAX_DENSITY_CV = 0.20;
const excludedTypes = new Set(["cover", "titlepage", "title-page", "toc", "landmarks"]);
const hasExcludedType = (value: string) => value.toLowerCase().split(/\s+/).some(type => excludedTypes.has(type));
const epubType = (node: Element) => node.getAttributeNS("http://www.idpf.org/2007/ops", "type") || attr(node, "epub:type");

/** Package semantics determine the population without opening every chapter.
 * Only EPUB3 navigation documents are read for their landmark references; never
 * follow ordinary TOC links or ask ReaderArchive.metadata() to discover titles.
 */
export function wordCountSpine(archive: CountArchive): string[] {
  const [path, root] = archive.opf(), items = manifestFromOpf(path, root, archive.resolve.bind(archive));
  const excluded = new Set<string>();
  const excludeReference = (from: string, href: string) => {
    if (href) excluded.add(archive.resolve(from, href));
  };
  for (const node of children(child(root, "guide") ?? root, "reference")) {
    if (hasExcludedType(attr(node, "type")) || hasExcludedType(epubType(node))) excludeReference(path, attr(node, "href"));
  }
  for (const node of children(child(root, "manifest") ?? root, "item")) {
    if (hasExcludedType(epubType(node))) excludeReference(path, attr(node, "href"));
  }
  for (const item of items) {
    if ([...item.properties].some(type => excludedTypes.has(type))) excluded.add(item.member_path);
    if (!item.properties.has("nav")) continue;
    excluded.add(item.member_path);
    const data = archive.read(item.member_path);
    if (!data) continue;
    let nav: Element;
    try { nav = parseXml(decodeHtmlDocument(data)); } catch { continue; }
    for (const node of [nav, ...descendants(nav)]) {
      if (node.localName === "a" && hasExcludedType(epubType(node))) excludeReference(item.member_path, attr(node, "href"));
    }
  }
  return linearSpineDocumentPaths(archive).filter(path => path && !excluded.has(path) && archive.members.has(path));
}
// Standalone epub:type markers are only observable in documents we actually read.
// If a sample reveals one, take the exact path and remove its bytes too. Discovering
// markers in *unread* chapters would require inflating the entire book.
function excludedDocument(html: string): boolean {
  if (!html.includes(":type")) return false;
  const tokenizer = new HtmlTokenizer(html), typeNames = new Set(["epub:type"]);
  let head = false;
  for (let token = tokenizer.next(); token; token = tokenizer.next()) {
    if (token.type === "start") {
      for (const attr of token.attrs) if (attr.name.startsWith("xmlns:") && attr.value === "http://www.idpf.org/2007/ops") typeNames.add(`${attr.name.slice(6)}:type`);
      if (token.name === "head") head = true;
      if (!head && ["html", "body", "section", "div", "nav"].includes(token.name) && token.attrs.some(attr => typeNames.has(attr.name) && hasExcludedType(attr.value))) return true;
    } else if (token.type === "end" && token.name === "head") head = false;
    else if (token.type === "text" && !head && token.data.trim()) break;
  }
  return false;
}
export function wordCountSampleIndices(n: number): number[] {
  const k = Math.min(WORD_COUNT_SAMPLES, n);
  return Array.from({ length: k }, (_, j) => Math.floor((j + 0.5) * n / k));
}
export interface WordCountSample { count: number; bytes: number }
export function sampleDensityCv(samples: readonly WordCountSample[]): number {
  if (!samples.length || samples.some(sample => !sample.bytes)) return Infinity;
  const densities = samples.map(sample => sample.count / sample.bytes), mean = densities.reduce((a, b) => a + b, 0) / densities.length;
  if (!mean) return Infinity; // All-image samples cannot establish the density of unseen prose.
  return Math.sqrt(densities.reduce((sum, density) => sum + (density - mean) ** 2, 0) / densities.length) / mean;
}
export function extrapolateWordCount(bytes: number, samples: readonly WordCountSample[]): number {
  const sampleBytes = samples.reduce((sum, sample) => sum + sample.bytes, 0);
  return sampleBytes ? Math.round(bytes * samples.reduce((sum, sample) => sum + sample.count, 0) / sampleBytes) : 0;
}
export interface EpubWordCount {
  count: number;
  totalBytes: number;
  documents: number;
  densityCv: number | null;
  fallback: "few-documents" | "small" | "uneven" | "requested" | null;
}
/** An exact count for small/heterogeneous books, otherwise a byte-weighted estimate. */
export function countEpubWords(archive: CountArchive, exact = false): EpubWordCount {
  const paths = wordCountSpine(archive), totalBytes = paths.reduce((sum, path) => sum + archive.members.get(path)!.size, 0);
  const counts = new Map<string, WordCountSample>(), excluded = new Set<string>();
  const count = (path: string): WordCountSample => {
    let sample = counts.get(path);
    if (!sample) {
      const data = archive.read(path);
      if (!data) throw new Error("Missing EPUB spine document");
      const html = decodeHtmlDocument(data);
      if (excludedDocument(html)) excluded.add(path);
      sample = excluded.has(path) ? { count: 0, bytes: 0 } : { count: countDocumentWords(html), bytes: archive.members.get(path)!.size };
      counts.set(path, sample);
    }
    return sample;
  };
  let fallback: EpubWordCount["fallback"] = exact ? "requested" : paths.length <= WORD_COUNT_SAMPLES ? "few-documents" : totalBytes < MIN_ESTIMATE_BYTES ? "small" : null;
  let densityCv: number | null = null, estimate = 0;
  if (!fallback) {
    const samples = wordCountSampleIndices(paths.length).map(index => count(paths[index]));
    densityCv = sampleDensityCv(samples);
    if (densityCv > MAX_DENSITY_CV) fallback = "uneven";
    else estimate = extrapolateWordCount(totalBytes, samples);
  }
  if (fallback) estimate = paths.reduce((sum, path) => sum + count(path).count, 0);
  const eligible = paths.filter(path => !excluded.has(path));
  return { count: estimate, totalBytes: excluded.size ? eligible.reduce((sum, path) => sum + archive.members.get(path)!.size, 0) : totalBytes, documents: eligible.length, densityCv, fallback };
}
