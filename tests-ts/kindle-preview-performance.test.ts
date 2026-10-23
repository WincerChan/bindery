import { afterEach, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { epubBaseHref, loadEpubItem } from "../src/core/epub";
import { encodeEpubPath } from "../src/core/epub-path";
import * as epubStrip from "../src/core/epub-strip";
import { kindlePreviewResource } from "../src/server/kindle/preview";
import { readerArchives } from "../src/server/reader/archive";
import { isolatedBookHtml, validateItemPath } from "../src/server/reader/resources";
import { requireBook } from "../src/server/http";
import * as readerService from "../src/server/reader/service";
import { epubPath } from "../src/server/storage";
import { obfuscatedEpub } from "./fixtures/reader/obfuscated";
import { readerFixture, readerRequest } from "./fixtures/reader/support";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); readerArchives.clear(); vi.restoreAllMocks(); });

// Time measurements are evidence only. Byte/read/plan counters enforce the guard
// independently of host load, including a hard failure on whole-copy APIs.
// The legacy whole-archive baseline costs seconds per sample and asserts nothing,
// so it only runs when a report is requested (BINDERY_BENCH or BINDERY_KINDLE_PERF_REPORT).
const benchmark = Boolean(process.env.BINDERY_BENCH || process.env.BINDERY_KINDLE_PERF_REPORT);
it("benchmarks indexed Kindle preview resources on a ~20 MB / 2241-member EPUB", async () => {
  const { id, library, cleanup } = readerFixture(); cleanups.push(cleanup);
  const book = obfuscatedEpub(2227, 9000, true), file = epubPath(library.base, id);
  writeFileSync(file, book.data);
  const path = book.paths[0], mode = "11000", prefix = `/devices/content/${id}/${mode}/epub/`;
  const request = readerRequest(prefix + encodeEpubPath(path)), members = new Set(book.entries.map(entry => entry.name));
  const elapsed = async (work: () => unknown) => { const start = performance.now(); await work(); return performance.now() - start; };
  // The pre-integration resource path, with the signature mismatch corrected only
  // for the measurement. It copies/strips/unpacks the entire EPUB every time.
  const legacy = async () => {
    requireBook(id, library); validateItemPath(path, members);
    const copy = epubStrip.stripEpubAssets(readFileSync(file), { stripFonts: true, stripImages: true });
    const [content] = loadEpubItem(copy, path, epubBaseHref(prefix, path));
    return new Response(isolatedBookHtml(content, epubBaseHref(prefix, path), request.url)).text();
  };
  const before: number[] = [];
  if (benchmark) for (let i = 0; i < 7; i++) before.push(await elapsed(legacy));
  const wholeStrip = vi.spyOn(epubStrip, "stripEpubAssets").mockImplementation(() => { throw new Error("Whole-archive strip in preview"); });
  const wholeRead = vi.spyOn(readerService, "readBookEpub").mockImplementation(() => { throw new Error("Whole-archive read in preview"); });
  const planBuild = vi.spyOn(epubStrip, "createEpubAssetStripper");
  const indexed = () => kindlePreviewResource(request, id, mode, path, library).text();
  const coldMs = await elapsed(indexed), archive = readerService.readBookArchive(id, library);
  expect(archive.members.size).toBe(2241); expect(book.data.byteLength).toBeGreaterThan(20 * 1024 * 1024);
  const cold = { ...archive.stats }, read = vi.spyOn(archive, "read");
  const after: number[] = [];
  for (let i = 0; i < 7; i++) after.push(await elapsed(indexed));
  expect(readerService.readBookArchive(id, library)).toBe(archive);
  expect(wholeStrip).not.toHaveBeenCalled(); expect(wholeRead).not.toHaveBeenCalled();
  expect(planBuild).toHaveBeenCalledTimes(1); expect(archive.stats.indexBuilds).toBe(1);
  expect(cold.memberReads).toBe(3); // container, OPF, target; no TOC or sibling chapter
  expect(read.mock.calls).toEqual(Array.from({ length: 7 }, () => [path]));
  expect(archive.stats.memberReads - cold.memberReads).toBe(7);
  expect(archive.stats.compressedBytesRead - cold.compressedBytesRead).toBe(7 * archive.members.get(path)!.compressedSize);
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const report = {
    archiveBytes: book.data.byteLength, members: archive.members.size, mode, samples: 7,
    legacyResourceMedianMs: benchmark ? median(before) : null, indexedResourceMedianMs: median(after), indexedColdMs: coldMs,
    indexBuilds: archive.stats.indexBuilds, planBuilds: planBuild.mock.calls.length,
    coldMemberReads: cold.memberReads, warmMemberReads: 1,
    warmCompressedBytes: archive.members.get(path)!.compressedSize,
  };
  console.info("KINDLE_PREVIEW_PERFORMANCE", JSON.stringify(report));
  if (process.env.BINDERY_KINDLE_PERF_REPORT) writeFileSync(process.env.BINDERY_KINDLE_PERF_REPORT, JSON.stringify(report, null, 2));
}, benchmark ? 120000 : 30000);
