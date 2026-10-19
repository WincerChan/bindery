import { crc32, deflateSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { writeArchive } from "../../../src/core/archive";
import { encodeEpubPath } from "../../../src/core/epub-path";
import { escapeHtml } from "../../../src/core/epub-html";

function pixelPng(): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length); result.write(type, 4); result.set(data, 8);
    result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 100, 150, 200, 255]))), chunk("IEND", new Uint8Array())]);
}

/** Entirely generated content: 2227 chapters + 14 package/assets members at full size. */
export function obfuscatedEpub(chapters = 3, payloadBytes = 32, performanceShape = false) {
  const dir = "OEBPS/Text/:|::|:::|||||:::|||/子 目录";
  const paths = Array.from({ length: chapters }, (_, index) => `${dir}/a:b ::| x*y~ ${performanceShape ? "" : '#?%<>" '}${index}.xhtml`);
  const css = 'OEBPS/Styles/:|*~/样 式#%?.css', importedCss = 'OEBPS/Styles/:|*~/二 级#%?.css';
  const image = 'OEBPS/Images/:|*~/图 片#%?<>\".png', font = "OEBPS/Fonts/:|*~/字体#%?.woff2";
  const relative = (path: string) => performanceShape && path.startsWith(dir) ? path.slice("OEBPS/".length) : encodeEpubPath(path.slice("OEBPS/".length));
  const asset = (path: string) => "../../../" + relative(path);
  const encode = (text: string) => new TextEncoder().encode(text);
  const entries = [
    { name: "mimetype", data: encode("application/epub+zip") },
    { name: "META-INF/container.xml", data: encode('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf"/></rootfiles></container>') },
    { name: "OEBPS/package.opf", data: encode(`<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="${relative(css)}" media-type="text/css"/><item id="image" href="${relative(image)}" media-type="image/png"/><item id="font" href="${relative(font)}" media-type="font/woff2"/>${paths.map((path, i) => `<item id="c${i}" href="${relative(path)}" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${paths.map((_, i) => `<itemref idref="c${i}"/>`).join("")}</spine></package>`) },
    { name: "OEBPS/nav.xhtml", data: encode(`<html xmlns="http://www.w3.org/1999/xhtml"><body><nav>${paths.map((path, i) => `<a href="${relative(path)}#note">第 ${i} 章</a>`).join("")}</nav></body></html>`) },
    { name: css, data: encode(`@import "${encodeEpubPath(importedCss.split("/").at(-1)!)}"; p{background:url("../../${relative(image)}")} @font-face{font-family:Book;src:url("../../${relative(font)}")}`) },
    { name: importedCss, data: encode(`p{background-image:url('../../${relative(image)}')}`) },
    { name: image, data: pixelPng() },
    { name: font, data: Uint8Array.from([119, 79, 70, 50, 0]) },
    ...["%2e%2e", "%2F", "#", "?", "a:b", "::|"].map(name => ({ name: `OEBPS/Images/${name}`, data: encode(name) })),
    ...paths.map((path, i) => ({ name: path, data: encode(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Fallback ${i}</title><link rel="stylesheet" href="${asset(css)}"/><style>p{background:url('${asset(image)}')}</style></head><body><p id="note">needle 第 ${i} 章 ${randomBytes(payloadBytes).toString("base64")}</p><a href="#note">脚注</a><a href="${encodeEpubPath(paths[(i + 1) % paths.length].split("/").at(-1)!)}#note">下章</a><img src="${asset(image)}"/><p style="background:url(&quot;${asset(image)}&quot;)">背景</p><script>parent.attack()</script><form><input/></form></body></html>`) })),
  ];
  return { data: writeArchive(entries), entries, paths, css, importedCss, image, font, relative, dir };
}
