import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { readArchive } from "../src/core/archive";
import { stripEpubAssets } from "../src/core/epub-strip";
import { assetEpub, coverStyleEpub } from "./support/kindle-assets";

// Recorded from HEAD before integration: ordered member names and exact payload bytes.
// ZIP timestamps are intentionally excluded, so this also works in another timezone.
const before = {
  "assets": {
    "10": "eabc1e5f04f347a0256ddf288d42806981815410f508ac3c49ef1738580c1ee3",
    "11": "8547231d6c53700d05d3565c41d628010ec2cb9e06a8e23a0674a0808ec7d2a5",
    "00": "3b70b8d93b0310cc16b214938265956f7242cae3a533baba10dce53b2f8c76cd",
    "01": "81bb45096bba9c15896ca7b64e07101d87918d6ec7a4c619e127f8739d7a89e6"
  },
  "transitive": {
    "10": "f5dd25f94e56cffe9d854e5515877f7885050ca647d4374aba76af0353d58dc6",
    "11": "b47a788eb2fa11e60b6f842b5109f7c19f345beea7367adad82cb0bb059a17d1",
    "00": "9fcb91095abb0b1a0cc6f82b4d2cbb0e6e9729f7521f04fefda9b079b1067bf0",
    "01": "088218266df022c51e18b56c51f9c24dafd26709ce584b79fefec1b0ed79d471"
  }
};
for (const mode of ["00", "01", "10", "11"] as const) {
  it(`preserves pre-integration copy bytes, encryption and cover CSS in mode ${mode}`, () => {
    for (const [name, data] of [["assets", assetEpub(true)], ["transitive", coverStyleEpub()]] as const) {
      const output = stripEpubAssets(data, { stripFonts: mode[0] === "1", stripImages: mode[1] === "1" });
      const members = readArchive(output).map(entry => [entry.name, createHash("sha256").update(entry.data).digest("hex")]);
      expect(createHash("sha256").update(JSON.stringify(members)).digest("hex")).toBe(before[name][mode]);
    }
  });
}
