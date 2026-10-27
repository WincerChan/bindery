# Staged ingest first-page preview

## API

`POST /ingest/first-page`, authenticated by the same `authenticatedRoute` wrapper as `/ingest/preview`.
Send JSON (normal session cookie):

```json
{ "upload_token": "<staged token>", "rule_id": "default", "theme_id": "default" }
```

Returns `{ section_title: string, volume_title: string | null, html: string }` or `{ error: string }` with a Chinese user message. Normal JSON responses are `Cache-Control: no-store`. Malformed JSON is HTTP 400; valid JSON with an invalid selection, stale token or unpreviewable content returns the error union at HTTP 200. Anonymous requests follow the existing login redirect behavior, before body parsing.

`html` is a complete HTML document for a **script-free sandboxed iframe's `srcdoc`**, with inline CSS and a restrictive meta CSP. No extra resource endpoint is needed. Toolbar changes can reuse the staging token; this endpoint neither consumes it nor creates jobs/library records. Token resolution uses only `loadStaged`; expiry follows existing staging cleanup (there is no separate preview TTL).

## Fidelity and bounded work

### TXT

- Uses `getRule`, `parseBookFileEvents`, and the exported `renderSection` used internally by both EPUB builders. Tests compare the complete sanitized chapter document, after applying the same theme, against both builders. Body equality is exact: no removal of volume elements or whitespace normalization in the comparison.
- Skips the metadata intro, volume-only sections and empty chapters; returns the first nonempty chapter.
- **No synthesized volume markup.** Builders render volumes separately. `volume_title` carries the enclosing volume name, or `null` when absent. It does not alter chapter HTML, even for a volume without prose.
- `composeBookCss` supplies the ingest theme composition/fallback. TXT `__book__` means the default theme, as in the processor.
- Preview-only parsing uses a 64 KiB encoding probe and a 256 KiB input ceiling. It must emit a complete chapter before exhausting the ceiling; a huge first chapter/prelude now returns `文件过大，无法预览第一页`, not a truncated chapter. Stopping or throwing closes the file iterator.
- Encoding probes may stop inside a codepoint. Actual chapter parsing validates the final codepoint at physical EOF. A file with mixed encodings or corruption after the probe can still differ from ingest's exhaustive encoding decision, or return a parse error. This is an explicit tradeoff to avoid scanning large staged files.
- Normal ingest is unchanged: unbounded strict UTF-8/GB18030 decoders read the whole stream and reject truncated final multibyte sequences. The event parser's existing encoding resolver catches those failures, tries the next encoding, and ultimately falls back to replacement text. It **does not itself throw** for every truncated file; regression tests preserve master's fallback rather than introducing a breaking change.

### EPUB

Uses the reader's indexed ZIP reader without calling library reader services (which can synchronize book CSS). Only the package, navigation documents needed for landmarks, candidate spine documents and selected document's stylesheets are read. It never scans later chapters just to discover their titles, nor inflates images/fonts.

Selection:

1. Construct the linear spine, excluding manifest `nav` entries. **Filenames never exclude a document**; a real chapter named `cover.xhtml`, `title.xhtml`, `toc.xhtml` or `nav.xhtml` remains eligible.
2. Read OPF guide and EPUB navigation-landmark hints. Prioritize linear documents referenced as `bodymatter`, `text` or `chapter`, retaining spine order among equally preferred documents. Explicit cover/title-page/toc/nav hints exclude front matter/navigation.
3. Examine those preferred documents, then the remaining documents in spine order. Ignore structurally non-visible content and semantically marked cover/titlepage/toc/nav documents (`epub:type` and `role="doc-*"`), including wrapper sections. A visible `bodymatter`/`text`/`chapter` semantic start qualifies even if short.
4. For unmarked content, require `MIN_PROSE_CHARACTERS = 24` Unicode letters/numbers outside headings, links, nav, script/style, SVG and other non-content/front-matter containers. This named heuristic accepts prose without requiring a particular language or `<p>` markup.
5. If no candidate qualifies, use the **first eligible linear non-nav document with any visible text**, including short prose, headings or links. Explicit front-matter exclusions still apply so a marked cover cannot displace a short real chapter. Image-only and structurally empty books return `未找到可预览的正文章节`.
6. Prefer the selected document's first h1, then h2, then title, then filename for `section_title`. `volume_title` is `null`; no volume hierarchy is inferred from EPUB navigation.

Guide/landmark hints are globally prioritized without scanning every chapter. In-document semantics are evaluated as candidates are encountered; absent package/navigation hints, a later chapter's semantics do not trigger a speculative scan beyond an already qualifying document. “Visible text” is structural, not browser-computed CSS visibility. These are bounded-work judgment calls, not full semantic/layout classification.

Selection considers at most 64 candidate paths, limits each requested member to 2 MiB and total requested uncompressed member bytes to 8 MiB. If the scan cannot finish within those limits, it returns `文件过大，无法预览第一页`, rather than falsely claiming no chapter exists or selecting a fallback from an incomplete scan. `ReadLimitError` is shared by bounded TXT and ZIP reads; the endpoint classifies it by type. The indexed reader bounds actual inflation output even if the ZIP directory lies about member size; Node's structured inflater limit code is translated to that class at the I/O boundary. Corrupt/non-EPUB data still returns `解析 EPUB 失败`. Unbounded `ReaderArchive.read(path)` retains its original stored/deflated behavior.

### Styles and implementation boundaries

`epubPage` orchestrates module-level helpers: `spinePlan` / `pickDocument`, `inlineStylesheets`, `resolveImports`, and `applyEpubTheme`. Recursion lives in named module-level functions, not nested recursive closures.

`__book__` retains linked/inline book CSS. `inlineCssImports` in `src/core/css-strip.ts` uses the existing escaped-token parser rather than a separate import regex:

- Quoted and `url()` imports, escaped identifiers/paths, and comments between tokens work.
- Local-relative imports resolve recursively against the importing stylesheet; media conditions are wrapped in `@media`, including linked-sheet `media` attributes.
- Cycles and chains beyond eight stylesheet levels are dropped. External and unresolved imports are removed.
- Import-looking comments and declaration strings remain literal; they are never loaded.
- Modern `layer()`/`supports()` import qualifiers are deliberately dropped, not misinterpreted as media conditions. This remains a fidelity limitation.

Other themes retain book CSS and append `composeBookCss` **after** it, replacing old Bindery stylesheet links, just like EPUB ingest's overlay behavior. A test compares themed output to `updateEpubMetadata` output re-previewed with `__book__`.

## Browser isolation

Reuses `isolatedBookHtml`, its element/attribute allowlists and CSS filtering, with a standalone mode. `resourceFreeCss` reuses token-aware `rewriteCssUrls` from the shared stripping pipeline, including escaped CSS identifiers and URL strings. It also neutralizes URL strings in `image-set`.

Scripts, event attributes, forms, embedded browsing contexts, imported meta/base tags and navigation URLs are removed. All images/SVG and linked asset elements are omitted; CSS asset URLs (including data URLs/fonts) are neutralized. Font-family declarations remain, falling back to locally available fonts; no embedded fonts are loaded. The generated document has no base URL and a meta CSP denying scripts, network/resource loads, forms and base overrides. The iframe must still be sandboxed without script permissions, as for reader content. No browser visual comparison is part of these backend tests.

The ordinary reader path is covered by `tests-ts/fixtures/ingest-first-page-master.json`: expected HTML was generated by executing master's `isolatedBookHtml` implementation at commit `39340ede1bb692a2aa07e6df5ea55782e5ad2b65`, with and without a resource resolver. The fixture includes linked/inline CSS, data images, SVG, navigation, disallowed elements and event attributes. It also records master's event-parser results for truncated multibyte files. Generation used isolated functions and temporary files, without importing a real library service.

## Reproducible verification

```sh
pnpm typecheck
pnpm exec vitest run tests-ts/ingest-first-page.test.ts --disableConsoleIntercept
pnpm build
pnpm test
```

The focused tests print `INGEST_FIRST_PAGE_TXT` and `INGEST_FIRST_PAGE_EPUB` measurements. Fixture creation/staging and network latency are excluded; timings include rule/theme lookup, parsing, sanitization and HTML generation, with no preview cache. Assertions enforce bytes/member reads rather than timing thresholds on shared CI machines.

Review-fix measurements, Node 24, isolated focused run:

| Fixture | Cold render | Median of 7 further renders | Maximum of 7 | Read assertion |
| --- | ---: | ---: | ---: | --- |
| 20,971,532-byte TXT (~20 MiB) | 1.87 ms | 0.68 ms | 0.96 ms | 131,072 bytes; no later chapter content |
| 22,727,112-byte EPUB (~21.67 MiB), 2,000 chapters | 23.17 ms | 22.74 ms | 26.68 ms | 4 members: container, OPF, first chapter, CSS |

The EPUB fixture uses stored ZIP entries to make archive size representative without relying on compressibility. All tests stage into temporary directories with temporary SQLite libraries. Final verification:

- `pnpm typecheck`: passed.
- Focused tests: **38 passed**, 1 file, **1.52 s**.
- `pnpm build`: passed; client **841 ms**, server **719 ms**. The existing mixed static/dynamic import warning for ingest multipart remains.
- `pnpm test` after that build: **1,533 passed, 2 skipped**; **92 files passed, 2 skipped**, **12.32 s**. Both production SPA tests passed.
- `git diff --check`: passed.

No UI/visual or network-latency benchmark was performed.
