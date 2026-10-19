import { HTML_ENTITIES } from "@xmldom/xmldom/lib/entities.js";

// Reuse the installed, pinned xmldom HTML5 table. These legacy names may omit ';'.
const legacy = new Set("AElig AMP Aacute Acirc Agrave Aring Atilde Auml COPY Ccedil ETH Eacute Ecirc Egrave Euml GT Iacute Icirc Igrave Iuml LT Ntilde Oacute Ocirc Ograve Oslash Otilde Ouml QUOT REG THORN Uacute Ucirc Ugrave Uuml Yacute aacute acirc acute aelig agrave amp aring atilde auml brvbar ccedil cedil cent copy curren deg divide eacute ecirc egrave eth euml frac12 frac14 frac34 gt iacute icirc iexcl igrave iquest iuml laquo lt macr micro middot nbsp not ntilde oacute ocirc ograve ordf ordm oslash otilde ouml para plusmn pound quot raquo reg sect shy sup1 sup2 sup3 szlig thorn times uacute ucirc ugrave uml uuml yacute yen yuml".split(" "));
const c1 = Array.from("€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ");
/** Python html.unescape: longest named prefix, optional semicolon and numeric fixups. */
export function unescapeSearchHtml(value: string): string {
  return value.replace(/&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g, (_, entity: string) => {
    if (entity.startsWith("#")) {
      const number = /^[xX]/.test(entity[1]) ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (number === 0 || number > 0x10ffff || number >= 0xd800 && number <= 0xdfff) return "\ufffd";
      if (number >= 128 && number <= 159) return c1[number - 128];
      if (number >= 1 && number <= 8 || number === 11 || number >= 14 && number <= 31 || number === 127 || number >= 0xfdd0 && number <= 0xfdef || (number & 0xffff) >= 0xfffe) return "";
      return String.fromCodePoint(number);
    }
    for (let end = entity.length; end >= 2; end--) {
      const part = entity.slice(0, end), name = part.endsWith(";") ? part.slice(0, -1) : legacy.has(part) ? part : "";
      if (name && Object.hasOwn(HTML_ENTITIES, name)) return HTML_ENTITIES[name] + entity.slice(end);
    }
    return "&" + entity;
  });
}
