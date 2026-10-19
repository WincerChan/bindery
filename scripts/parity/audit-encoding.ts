import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { decodeGb18030 } from "../../src/core/gb18030.ts";
const input = JSON.parse(readFileSync(process.argv[2], "utf8")) as {
  pairs: [string, string | null][];
  ranges: [number, number, number | null][];
};
let count = 0;
function compare(bytes: Uint8Array, expected: string | null) {
  let actual: string | null = null;
  try {
    actual = decodeGb18030(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  assert.equal(actual, expected, Buffer.from(bytes).toString("hex"));
  count++;
}
for (const [hex, value] of input.pairs) compare(Buffer.from(hex, "hex"), value);
for (const [start, end, code] of input.ranges) {
  for (let pointer = start; pointer <= end; pointer++) {
    let x = pointer;
    const fourth = (x % 10) + 0x30;
    x = Math.floor(x / 10);
    const third = (x % 126) + 0x81;
    x = Math.floor(x / 126);
    const second = (x % 10) + 0x30;
    x = Math.floor(x / 10);
    compare(
      new Uint8Array([x + 0x81, second, third, fourth]),
      code === null ? null : String.fromCodePoint(code + pointer - start),
    );
  }
}
console.log(`GB18030 exhaustive parity: ${count} sequences, zero differences`);
