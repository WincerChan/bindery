import { build } from "vite";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("bundles and executes the complete core with browser dependency resolution", async () => {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      lib: {
        entry: resolve("src/core/index.ts"),
        formats: ["es"],
        fileName: "bindery-core",
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const chunk = outputs
    .flatMap((o) => ("output" in o ? o.output : []))
    .find((o) => o.type === "chunk" && o.isEntry);
  if (!chunk || chunk.type !== "chunk")
    throw new Error("Missing browser core bundle");
  expect(chunk.imports).toEqual([]);
  expect(chunk.code).not.toMatch(/from\s*["']node:/);
  expect(chunk.code).not.toMatch(
    /\brequire\(["'](?:node:|fs|path|stream|zlib)/,
  );
  // Use the bundled artifact rather than the source; globals are shared with browsers.
  const core: typeof import("../src/core/index") = await import(
    /* @vite-ignore */ "data:text/javascript;base64," +
      Buffer.from(chunk.code).toString("base64")
  );
  const book = core.parseBookBytes(
    new TextEncoder().encode("书名：浏览器核心\n第一章\n正文"),
    "source",
  );
  const meta = core.metadataFromDict({
    book_id: "browser-id",
    title: book.title,
  });
  const data = core.buildEpub(book, meta);
  expect(core.extractEpubMetadata(data, "fallback").title).toBe("浏览器核心");
  expect(core.listEpubSections(data)[0].title).toBe("第一章");
  expect(
    core.extractEpubMetadata(
      core.updateEpubMetadata(data, { ...meta, title: "更新" }),
      "fallback",
    ).title,
  ).toBe("更新");
});
