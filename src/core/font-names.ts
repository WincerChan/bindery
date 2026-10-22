/**
 * Kobo puts the chosen family into its reader CSS without quotes and loses non-ASCII text, so a family
 * such as "Zhuque Fangsong (technical preview)" or "寒蝉端黑宋Pro" (shown as "?????Pro") is dropped and
 * the book's fonts come back. The name must be ASCII CSS identifiers: parenthetical qualifiers are
 * removed, other punctuation breaks words, and a word cannot start with a digit. A family with any
 * non-ASCII text uses the PostScript name instead, which is ASCII by definition, minus its style.
 */
export function koboFamilyName(family: string, postscript?: string): string {
  const words = (text: string) => {
    const safe: string[] = [];
    for (const word of text.replace(/\s*\([^()]*\)/g, " ").replace(/[^\w\- ]/g, " ").split(/\s+/).map(item => item.replace(/^-+(?=\d|$)/, "")).filter(Boolean)) {
      if (/^\d/.test(word) && safe.length) safe[safe.length - 1] += word;
      else safe.push(/^\d/.test(word) ? `F${word}` : word);
    }
    return safe.join(" ");
  };
  const fromPostscript = () => words((postscript ?? "").replace(/[-_][A-Za-z]+$/, ""));
  return (/[^\x00-\x7f]/.test(family) ? fromPostscript() : words(family) || fromPostscript()) || "Font";
}

const FAMILY_NAME_IDS = new Set([1, 4, 16, 21]);
const ascii = (text: string) => /^[\x20-\x7e]*$/.test(text);
const checksum = (bytes: Uint8Array) => {
  const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4); padded.set(bytes);
  const view = new DataView(padded.buffer); let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + view.getUint32(i)) >>> 0;
  return sum;
};

/**
 * Sets every family and typographic family record (IDs 1, 16, 21) to `family` and every full name (ID 4)
 * to `full`, in all languages, so the device cannot pick a stale localized name. Glyphs and all other
 * tables stay byte for byte; the new name table is appended and the table directory and head checksum
 * are updated. Returns null when no record changes.
 */
export function renameFontFamily(data: Uint8Array, names: { family: string; full: string }): Uint8Array<ArrayBuffer> | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength), tables = view.getUint16(4);
  const entry = (tag: string) => { for (let i = 0; i < tables; i++) { const at = 12 + i * 16; if (String.fromCharCode(...data.subarray(at, at + 4)) === tag) return at; } return -1; };
  const nameEntry = entry("name"), headEntry = entry("head");
  if (nameEntry < 0 || headEntry < 0) return null;
  const offset = view.getUint32(nameEntry + 8), length = view.getUint32(nameEntry + 12);
  if (offset + length > data.length || length < 6) throw new Error("字体名称表损坏");
  const count = view.getUint16(offset + 2), strings = offset + view.getUint16(offset + 4);
  if (6 + count * 12 > length) throw new Error("字体名称表损坏");
  const utf16 = (text: string) => { const out = new Uint8Array(text.length * 2), out16 = new DataView(out.buffer); for (let i = 0; i < text.length; i++) out16.setUint16(i * 2, text.charCodeAt(i)); return out; };
  let changed = false;
  const records = Array.from({ length: count }, (_, index) => {
    const at = offset + 6 + index * 12, [platform, encoding, language, id, size, start] = [0, 2, 4, 6, 8, 10].map(field => view.getUint16(at + field));
    let bytes = data.slice(strings + start, strings + start + size);
    if (FAMILY_NAME_IDS.has(id)) {
      const next = id === 4 ? names.full : names.family;
      if (platform === 0 || platform === 3) {
        if (new TextDecoder("utf-16be").decode(bytes) !== next) { bytes = utf16(next); changed = true; }
      } else if (platform === 1 && encoding === 0 && ascii(next)) {
        // Mac Roman encodes ASCII byte for byte.
        if (new TextDecoder("macintosh").decode(bytes) !== next) { bytes = new TextEncoder().encode(next); changed = true; }
      }
    }
    return { platform, encoding, language, id, bytes };
  });
  if (!changed) return null;
  // Format 0; the original records are already in the required platform/encoding/language/id order.
  const stringBytes = records.reduce((sum, record) => sum + record.bytes.length, 0), headerSize = 6 + records.length * 12;
  const table = new Uint8Array(headerSize + stringBytes), tableView = new DataView(table.buffer);
  tableView.setUint16(2, records.length); tableView.setUint16(4, headerSize);
  let cursor = 0;
  records.forEach((record, index) => {
    const at = 6 + index * 12;
    [record.platform, record.encoding, record.language, record.id, record.bytes.length, cursor].forEach((value, field) => tableView.setUint16(at + field * 2, value));
    table.set(record.bytes, headerSize + cursor); cursor += record.bytes.length;
  });
  const start = Math.ceil(data.length / 4) * 4, output = new Uint8Array(start + Math.ceil(table.length / 4) * 4), out = new DataView(output.buffer);
  output.set(data); output.set(table, start);
  out.setUint32(nameEntry + 4, checksum(table)); out.setUint32(nameEntry + 8, start); out.setUint32(nameEntry + 12, table.length);
  const head = out.getUint32(headEntry + 8);
  out.setUint32(head + 8, 0);
  out.setUint32(head + 8, (0xb1b0afba - checksum(output)) >>> 0);
  return output;
}
