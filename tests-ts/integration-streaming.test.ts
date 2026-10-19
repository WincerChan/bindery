import { afterEach, describe, expect, it, vi } from "vitest";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildEpubFromSectionStream, writeEpubFromSectionStream, type StreamBuildSection } from "../src/core/epub";
import { readArchive } from "../src/core/archive";
import { metadataFromDict } from "../src/core/models";
import { parseBookFileEvents } from "../src/server/parsing";

afterEach(() => vi.useRealTimers());
describe("sink EPUB writer", () => {
  it("matches every buffered byte for a long TXT and writes while sections are being read", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
    const root = mkdtempSync(join(tmpdir(), "bindery-streaming-"));
    try {
      const source = join(root, "long.txt"), output = join(root, "book.epub");
      writeFileSync(source, "《长篇》\n作者：作者\n简介：简介\n" + Array.from({ length: 320 }, (_, n) => `\n第${n + 1}章 正文\n` + `长篇正文${n}😀<&>。\n`.repeat(250)).join(""));
      const first = parseBookFileEvents(source, "long").next().value;
      if (!first || !("intro" in first)) throw new Error("Missing header");
      let passes = 0, produced = 0, writingDuringRead = false;
      function* sections(): Generator<StreamBuildSection> {
        passes++; produced = 0;
        for (const entry of parseBookFileEvents(source, "long")) if ("kind" in entry) { produced++; yield entry; }
      }
      const args = { meta: metadataFromDict({ book_id: "a".repeat(32), title: "长篇", tags: ["甲"], description: "简介" }), source_author: first.author, source_intro: first.intro, css_text: " p { color:red } ", cover: { name: "中文.png", data: new Uint8Array([1, 2, 3]) } };
      const fd = openSync(output, "w");
      try { writeEpubFromSectionStream({ ...args, stream_sections: sections }, chunk => {
        if (passes === 2 && produced > 1 && produced < 320) writingDuringRead = true;
        let offset = 0; while (offset < chunk.length) offset += writeSync(fd, chunk, offset);
      }); } finally { closeSync(fd); }
      expect(passes).toBe(2); expect(writingDuringRead).toBe(true);
      const actual = readFileSync(output), expected = buildEpubFromSectionStream({ ...args, stream_sections: sections() });
      // Includes member order, compression, headers and all member contents.
      expect(actual.equals(Buffer.from(expected))).toBe(true); expect(readArchive(actual).length).toBe(328);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each([false, true])("matches an empty source and intro-only source (%s)", intro => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
    const args = { meta: metadataFromDict({ book_id: "b".repeat(32), title: "空书" }), source_author: null, source_intro: intro ? "简介" : null };
    const chunks: Uint8Array[] = [];
    writeEpubFromSectionStream({ ...args, stream_sections: () => [] }, chunk => chunks.push(chunk));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(buildEpubFromSectionStream({ ...args, stream_sections: [] })));
  });
  it("propagates sink failures and detects changed section indexes", () => {
    const args = { meta: metadataFromDict({ title: "测试" }), source_author: null, source_intro: null };
    expect(() => writeEpubFromSectionStream({ ...args, stream_sections: () => [] }, () => { throw new Error("disk full"); })).toThrow("disk full");
    let pass = 0;
    expect(() => writeEpubFromSectionStream({ ...args, stream_sections: () => [{ kind: "chapter", title: String(++pass), lines: [] }] }, () => {})).toThrow("changed between passes");
  });
});
