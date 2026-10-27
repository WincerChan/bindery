import { decodeGb18030 } from "./gb18030";
import { HtmlTokenizer } from "./html-tokenizer";

const utf8 = new TextDecoder("utf-8");
function declaredEncoding(text: string): string | undefined {
  const xml = /^\s*<\?xml\s[^?]*?\bencoding\s*=\s*(['"])(.*?)\1/i.exec(text);
  if (xml) return xml[2];
  if (!/<meta\b/i.test(text)) return;
  // Tokenization avoids mistaking comments, scripts or quoted attributes for declarations.
  const tokenizer = new HtmlTokenizer(text);
  for (let token = tokenizer.next(); token; token = tokenizer.next()) {
    if (token.type === "start" && token.name === "body" || token.type === "end" && token.name === "head") break;
    if (token.type !== "start" || token.name !== "meta") continue;
    const attrs = Object.fromEntries(token.attrs.map(attr => [attr.name, attr.value]));
    if (attrs.charset) return attrs.charset;
    if (attrs["http-equiv"]?.trim().toLowerCase() === "content-type") {
      const charset = /\bcharset\s*=\s*['"]?\s*([^\s;'">]+)/i.exec(attrs.content || "");
      if (charset) return charset[1];
    }
  }
}
/** Best-effort chapter decoding: BOM, XML declaration, HTML meta, then non-fatal UTF-8. */
export function decodeHtmlDocument(data: Uint8Array): string {
  // BOMs take precedence over declarations. Also recognize BOM-less UTF-16 markup.
  if (data[0] === 0xff && data[1] === 0xfe || data[0] === 0x3c && data[1] === 0) return new TextDecoder("utf-16le").decode(data);
  if (data[0] === 0xfe && data[1] === 0xff || data[0] === 0 && data[1] === 0x3c) return new TextDecoder("utf-16be").decode(data);
  const text = utf8.decode(data);
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return text;
  const encoding = declaredEncoding(text)?.trim().toLowerCase();
  if (!encoding || encoding === "utf-8" || encoding === "utf8") return text;
  if (["gb18030", "gbk", "gb2312"].includes(encoding)) {
    try { return decodeGb18030(data); }
    catch { return new TextDecoder("gb18030").decode(data); } // Salvage damaged chapters too.
  }
  try { return new TextDecoder(encoding).decode(data); }
  catch { return text; } // An unsupported label must not invalidate the whole book.
}
