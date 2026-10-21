// the legacy implementation's gb18030 codec uses the original GB18030 mappings. WHATWG/ICU
// TextDecoder uses later revisions. These 20 two-byte mappings and one
// four-byte mapping are the complete differences in Node 24's ICU decoder.
// Also reject 0x80: WHATWG accepts it as Euro, whereas legacy rejects it.
const legacyPairs: Record<number, number> = {
  0xa3a0: 0xe5e5,
  0xa6d9: 0xe78d,
  0xa6da: 0xe78e,
  0xa6db: 0xe78f,
  0xa6dc: 0xe790,
  0xa6dd: 0xe791,
  0xa6de: 0xe792,
  0xa6df: 0xe793,
  0xa6ec: 0xe794,
  0xa6ed: 0xe795,
  0xa6f3: 0xe796,
  0xa8bc: 0xe7c7,
  0xfe59: 0xe81e,
  0xfe61: 0xe826,
  0xfe66: 0xe82b,
  0xfe67: 0xe82c,
  0xfe6d: 0xe832,
  0xfe7e: 0xe843,
  0xfe90: 0xe854,
  0xfea0: 0xe864,
};
export function decodeGb18030(data: Uint8Array): string {
  const decoder = new TextDecoder("gb18030", { fatal: true, ignoreBOM: true });
  const chunks: string[] = [];
  let start = 0;
  const invalid = () => {
    throw new TypeError("Invalid legacy gb18030 sequence");
  };
  for (let i = 0; i < data.length;) {
    const lead = data[i];
    if (lead < 0x80) {
      i++;
      continue;
    }
    if (lead < 0x81 || lead > 0xfe || i + 1 >= data.length) invalid();
    const trail = data[i + 1];
    let replacement: number | undefined,
      length = 2;
    if (trail >= 0x30 && trail <= 0x39) {
      const third = data[i + 2],
        fourth = data[i + 3];
      length = 4;
      if (
        i + 3 >= data.length ||
        third < 0x81 ||
        third > 0xfe ||
        fourth < 0x30 ||
        fourth > 0x39
      )
        invalid();
      const pointer =
        ((lead - 0x81) * 10 + trail - 0x30) * 1260 +
        (third - 0x81) * 10 +
        fourth -
        0x30;
      if (!(pointer <= 39419 || (pointer >= 189000 && pointer <= 1237575)))
        invalid();
      if (pointer === 7457) replacement = 0x1e3f;
    } else {
      if (trail < 0x40 || trail > 0xfe || trail === 0x7f) invalid();
      replacement = legacyPairs[(lead << 8) | trail];
    }
    if (replacement !== undefined) {
      chunks.push(
        decoder.decode(data.subarray(start, i)),
        String.fromCodePoint(replacement),
      );
      start = i + length;
    }
    i += length;
  }
  chunks.push(decoder.decode(data.subarray(start)));
  return chunks.join("");
}
