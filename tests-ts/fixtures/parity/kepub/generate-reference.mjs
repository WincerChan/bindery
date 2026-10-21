// Regenerates reference.json with the real kepubify binary. Tests never run this.
// Usage: KEPUBIFY=/path/to/kepubify node tests-ts/fixtures/parity/kepub/generate-reference.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const here = dirname(fileURLToPath(import.meta.url));
const kepubify = process.env.KEPUBIFY;
if (!kepubify) throw new Error("Set KEPUBIFY to the kepubify v4.0.4 binary");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const textMember = name => /\.(?:xhtml|html?|opf|xml|ncx|css|txt|svg)$/i.test(name);
const temp = mkdtempSync(join(tmpdir(), "kepubify-reference-"));
const inputs = readdirSync(here).filter(name => /^input-.*\.epub$/.test(name)).sort();
const reference = {
  generator: { tool: "kepubify", version: "4.0.4", sha256: sha256(readFileSync(kepubify)), date: new Date().toISOString().slice(0, 10) },
  normalization: "Member order is sorted by name. ZIP metadata, timestamps, compression and comments are ignored. Text member bytes are stored verbatim; other members store SHA-256.",
  inputs: [],
};
try {
  for (const name of inputs) {
    const input = join(here, name), output = join(temp, name.replace(/\.epub$/i, ".kepub.epub"));
    execFileSync(kepubify, ["-o", output, input], { stdio: "pipe" });
    const members = Object.entries(unzipSync(readFileSync(output))).sort(([a], [b]) => a.localeCompare(b)).map(([member, data]) => {
      const bytes = Buffer.from(data);
      return textMember(member) ? { name: member, text: bytes.toString("utf8") } : { name: member, sha256: sha256(bytes), size: bytes.length };
    });
    reference.inputs.push({ input: name, inputSha256: sha256(readFileSync(input)), dummyTitlepage: members.some(member => member.name.endsWith("kepubify-titlepage-dummy.xhtml")), members });
  }
  writeFileSync(join(here, "reference.json"), JSON.stringify(reference, null, 2) + "\n");
} finally { rmSync(temp, { recursive: true, force: true }); }
