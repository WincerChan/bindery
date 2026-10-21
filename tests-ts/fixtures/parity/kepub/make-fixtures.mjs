// Builds the deterministic small EPUB inputs used by the KEPUB parity test.
// Usage: node tests-ts/fixtures/parity/kepub/make-fixtures.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Zip, ZipPassThrough } from "fflate";

const here = dirname(fileURLToPath(import.meta.url));
function archive(entries) {
  const chunks = [];
  const zip = new Zip((error, chunk) => { if (error) throw error; chunks.push(chunk); });
  for (const [name, text] of entries) {
    const file = new ZipPassThrough(name);
    file.mtime = Date.UTC(2020, 0, 1);
    zip.add(file);
    file.push(new TextEncoder().encode(text), true);
  }
  zip.end();
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
}
const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
function opf(items, spine, metadata = "") {
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">fixture</dc:identifier><dc:title>KEPUB fixture</dc:title>${metadata}</metadata>
  <manifest>${items}</manifest>
  <spine>${spine}</spine>
  <guide><reference type="text" title="Start" href="Text/mixed.xhtml"/></guide>
</package>`;
}

// Covers sentence splitting, inline nesting, br, pre/code, script/style, svg,
// math, images, tables, footnote links, entities, malformed HTML and charset.
const mixed = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN"><head>
<meta http-equiv="Content-Type" content="application/xhtml+xml; charset=GBK"/>
<title>Mixed</title>
<style type="text/css">p > a { color: red; }</style>
<script type="text/javascript">if (a < b && c > d) { x = "&"; }</script>
</head>
<body class="main">
<p id="first">中文句子。第二句！English sentence. Next&nbsp;part &amp; &#160; &lt;tag&gt; “引号” — dash</p>
<p>Sentence <b>bold 1. </b>plain <i>italic <span>nested 2. Se</span>nt</i>ence <a href="notes.xhtml#n1" id="ref1">footnote 3. Another</a>.</p>
<p>Line one<br/>line two<br />line three</p>
<pre>  pre text
 &amp; stays raw</pre>
<p><code>a&lt;b</code></p>
<p><img src="../Images/pixel.png" alt="a&amp;b"/> after image. Final.</p>
<table><tr><td>Cell one.</td><td><p>Cell two. Second sentence.</p></td></tr></table>
<p>Entities: &copy; &mdash; &#x4E2D; &unknown; &amp;amp;</p>
<p><a/>self closing link. <span/>empty span.</p>
<p>a<p>b</p>c</p><div><span>d</div>e
<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><title>svg title</title><text x="0" y="5">SVG text.</text></svg>
<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi><mo>=</mo><mn>1</mn></math>
</body></html>`;
const existingSpans = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Existing</title></head><body><p><span class="koboSpan" id="kobo.1.1">Already spanned.</span> Not again.</p></body></html>`;
const existingDivs = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Divs</title></head><body><div id="book-columns"><div id="book-inner"><p>Wrapped once. Two sentences.</p></div></div></body></html>`;
const empty = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Empty</title></head><body><!-- empty --></body></html>`;
const special = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Special</title></head><body><p>特殊 路径 &amp; notes. Second sentence.</p></body></html>`;
const specialPath = "Text/第 1 章 & notes.xhtml";
writeFileSync(join(here, "input-mixed.epub"), archive([
  ["mimetype", "application/epub+zip"],
  ["META-INF/container.xml", container],
  ["OEBPS/content.opf", opf(
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="mixed" href="Text/mixed.xhtml" media-type="application/xhtml+xml"/><item id="spans" href="Text/spans.xhtml" media-type="application/xhtml+xml"/><item id="divs" href="Text/divs.xhtml" media-type="application/xhtml+xml"/><item id="empty" href="Text/empty.xhtml" media-type="application/xhtml+xml"/><item id="special" href="${specialPath.replaceAll("&", "&amp;")}" media-type="application/xhtml+xml"/><item id="pixel" href="Images/pixel.png" media-type="image/png"/><item id="css" href="Styles/book.css" media-type="text/css"/>`,
    `<itemref idref="mixed"/><itemref idref="spans"/><itemref idref="divs"/><itemref idref="empty"/><itemref idref="special"/>`,
    `<meta name="calibre:timestamp" content="2020-01-01T00:00:00+00:00"/><meta name="cover" content="pixel"/>`,
  )],
  ["OEBPS/Text/mixed.xhtml", mixed],
  ["OEBPS/Text/spans.xhtml", existingSpans],
  ["OEBPS/Text/divs.xhtml", existingDivs],
  ["OEBPS/Text/empty.xhtml", empty],
  [`OEBPS/${specialPath}`, special],
  ["OEBPS/Images/pixel.png", "not-a-real-png"],
  ["OEBPS/Styles/book.css", "p { color: black; }"],
  ["OEBPS/toc.ncx", `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="a"><navLabel><text>Start</text></navLabel><content src="Text/mixed.xhtml"/></navPoint></navMap></ncx>`],
  ["OEBPS/.DS_STORE", "filtered"],
  ["__MACOSX/junk", "filtered"],
  ["OEBPS/calibre_bookmarks.txt", "filtered"],
  ["OEBPS/iTunesMetadata.plist", "filtered"],
  ["OEBPS/thumbs.db", "filtered"],
  ["OEBPS/Images/", ""],
]));

// A title page in the first linear spine: no dummy title page.
writeFileSync(join(here, "input-titlepage.epub"), archive([
  ["mimetype", "application/epub+zip"],
  ["META-INF/container.xml", container],
  ["OEBPS/content.opf", `\uFEFF<?xml version="1.0" encoding="utf-8"?>\r\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">\r\n  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">title</dc:identifier><dc:title>Title</dc:title><meta name="cover" content="cover-image"/></metadata>\r\n  <manifest><item id="cover" href="Text/cover.xhtml" media-type="application/xhtml+xml"/><item id="chapter" href="Text/chapter.xhtml" media-type="application/xhtml+xml"/><item id="cover-image" href="Images/cover.png" media-type="image/png"/></manifest>\r\n  <spine><itemref idref="cover"/><itemref idref="chapter"/></spine>\r\n</package>\r\n`],
  ["OEBPS/Text/cover.xhtml", `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cover</title></head><body><img src="../Images/cover.png" alt="cover"/></body></html>`],
  ["OEBPS/Text/chapter.xhtml", `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><h1>Chapter</h1><p>One. Two?</p></body></html>`],
  ["OEBPS/Images/cover.png", "cover"],
]));

// No title page and a non-linear cover: kepubify adds its blank title page.
writeFileSync(join(here, "input-dummy.epub"), archive([
  ["mimetype", "application/epub+zip"],
  ["META-INF/container.xml", container],
  ["OEBPS/content.opf", opf(
    `<item id="cover" href="Text/cover.xhtml" media-type="application/xhtml+xml"/><item id="start" href="Text/start.xhtml" media-type="application/xhtml+xml"/><item id="cover-image" href="Images/cover.png" media-type="image/png"/>`,
    `<itemref idref="cover" linear="no"/><itemref idref="start"/>`,
    `<meta name="cover" content="cover-image"/><dc:contributor role="bkp">calibre</dc:contributor>`,
  )],
  ["OEBPS/Text/cover.xhtml", `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cover</title></head><body><img src="../Images/cover.png"/></body></html>`],
  ["OEBPS/Text/start.xhtml", `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Start</title></head><body><div>Short text.</div></body></html>`],
  ["OEBPS/Images/cover.png", "cover"],
]));
