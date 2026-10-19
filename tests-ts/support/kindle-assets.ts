import { readFileSync } from "node:fs";
import { writeArchive } from "../../src/core/archive";

const encode = (text: string) => new TextEncoder().encode(text);
export const assetCover = new Uint8Array(readFileSync(new URL("../fixtures/cover 中文.png", import.meta.url)));
// boko stores embedded font resources verbatim; this is a synthetic SFNT, not a system font dependency.
export const assetFont = new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
export function assetEpub(encrypted = false): Uint8Array<ArrayBuffer> {
  const xhtml = (body: string, head = "") => encode(`<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Assets</title><link rel="stylesheet" href="../Styles/book.css"/>${head}</head><body>${body}</body></html>`);
  const entries = [
    { name: "mimetype", data: encode("application/epub+zip") },
    { name: "META-INF/container.xml", data: encode('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>') },
    { name: "EPUB/content.opf", data: encode(`<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:kindle-assets</dc:identifier><dc:title>Assets</dc:title><dc:language>en</dc:language><meta name="cover" content="cover"/></metadata><manifest>
      <item id="cover" href="Images/cover.png" media-type="image/png" properties="cover-image"/>
      <item id="illustration" href="Images/art.png" media-type="image/png"/>
      <item id="odd-image" href="Images/picture" media-type="image/jpeg"/>
      <item id="font" href="Fonts/book.ttf" media-type="font/ttf"/>
      <item id="odd-font" href="Fonts/obfuscated" media-type="application/vnd.ms-opentype"/>
      <item id="style" href="Styles/book.css" media-type="text/css"/>
      <item id="cover-page" href="Text/cover.xhtml" media-type="application/xhtml+xml"/>
      <item id="chapter" href="Text/chapter.xhtml" media-type="application/xhtml+xml"/>
      </manifest><spine><itemref idref="cover-page"/><itemref idref="chapter"/></spine><guide><reference type="cover" href="Text/cover.xhtml"/></guide></package>`) },
    { name: "EPUB/Styles/book.css", data: encode('@font-face { font-family: "Publisher"; src: url("../Fonts/book.ttf"); } body, p { font-family: "Publisher"; color: black; } .art { background-image: url("../Images/art.png"); } .cover { background: url("../Images/cover.png") center; }') },
    { name: "EPUB/Text/cover.xhtml", data: xhtml('<section epub:type="cover"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 300"><image xlink:href="../Images/cover.png" width="200" height="300"/></svg></section>') },
    { name: "EPUB/Text/chapter.xhtml", data: xhtml('<h1>Chapter</h1><p style="font-family: Publisher; text-indent: 1em">Text survives &amp; stays valid.</p><figure><img src="../Images/art.png" alt="Art"/></figure><picture><source srcset="../Images/art.png"/><img src="../Images/art.png"/></picture><svg xmlns="http://www.w3.org/2000/svg"><image href="../Images/art.png"/></svg><figure><img src="../Images/cover.png"/></figure><figure><img src="../Images/art.png"/><figcaption>Keep this caption</figcaption></figure><p class="art" style="background: url(../Images/picture); color: red">More text</p>', '<style>@media all { p { font-family: Publisher; } } @font-face { font-family: Inline; src: url(../Fonts/book.ttf); }</style>') },
    { name: "EPUB/Images/cover.png", data: assetCover },
    { name: "EPUB/Images/art.png", data: assetCover },
    { name: "EPUB/Images/picture", data: assetCover },
    { name: "EPUB/Images/unlisted.gif", data: assetCover },
    { name: "EPUB/Fonts/book.ttf", data: assetFont },
    { name: "EPUB/Fonts/obfuscated", data: assetFont },
    ...["otf", "woff", "woff2"].map(ext => ({ name: `EPUB/Fonts/unlisted.${ext}`, data: assetFont })),
  ];
  if (encrypted) entries.push({ name: "META-INF/encryption.xml", data: encode('<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><CipherData><CipherReference URI="EPUB/Fonts/book.ttf"/></CipherData></EncryptedData><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><CipherData><CipherReference URI="EPUB/Images/art.png"/></CipherData></EncryptedData></encryption>') });
  return new Uint8Array(writeArchive(entries));
}
