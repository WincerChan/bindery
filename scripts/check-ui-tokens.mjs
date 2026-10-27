import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Product palette from design §2.1, §5.1 and §5.2; prototype-canvas colors are excluded.
const palette = new Set(`F6F4EE FBFAF6 ECEAE2 EFEDE5 F4F1E8 FFFFFF 22262A
202923 4B554E 656D66 92998F 7A8178 DEDDD2 E4E2D8 C8C8BB A24832 35674C 855C17 A43B2B E8EEE8 F4ECE4 F6E8E3
6E3B2E F3E6DA 7A2E2A F4E4D6 A8483B F8E7DC 8C5A3C F6E9D8 C9A44C 2B2416 E4D7C0 5B2A22 D9CDB4 3A3326 B8C2B3 273229 5A6B5D F0EBDC 2F4A3E E8E4CF 2C3A52 E3E1D6 45384A ECE2D8 3D3A35 E9DFC8
23282A 3E4144 C9CBC2 EDEBE4`.split(/\s+/));
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}
const owned = process.argv.includes("--owned"), errors = [];
for (const path of ["src/styles.css", ...files("src/ui").filter(path => /\.(css|tsx?|md)$/.test(path))]) {
  let text = readFileSync(path, "utf8");
  if (owned && path === "src/styles.css") text = text.split(".auth-page")[0];
  const report = (index, message) => errors.push(`${path}:${text.slice(0, index).split("\n").length}: ${message}`);
  for (const match of text.matchAll(/(?:#|%23)([\da-f]{6}|[\da-f]{3})(?![\da-f])/gi)) {
    const value = match[1].length === 3 ? [...match[1]].map(char => char + char).join("") : match[1];
    if (!palette.has(value.toUpperCase())) report(match.index, `color outside palette: ${match[0]}`);
  }
  for (const match of text.matchAll(/(?:font-size|font)\s*:\s*([^;}]+)/g)) {
    const value = match[1];
    for (const size of value.matchAll(/(?<![\d.])([\d.]+)(px|rem|em|cqi)\b/g)) {
      const pixels = Number(size[1]) * (size[2] === "rem" || size[2] === "em" ? 16 : 1);
      // Container sizes are legal only with an explicit >=12px lower bound.
      const bounded = /(?:max|clamp)\(\s*(?:1[2-9]|[2-9]\d)px\s*,/.test(value);
      if (!bounded && (size[2] === "cqi" || pixels < 12)) report(match.index, `font size below/unbounded by 12px: ${value}`);
    }
  }
}
if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
else console.log(`UI palette and minimum type checks passed (${owned ? "owned scope" : "full scope"}).`);
