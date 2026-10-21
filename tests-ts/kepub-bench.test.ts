import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "vitest";
import { convertToKepub, convertToKepubAsync } from "../src/core/kepub";

/** Never part of the default suite; run with BINDERY_BENCH=1. */
const enabled = process.env.BINDERY_BENCH === "1";
const library = resolve(process.env.BINDERY_BENCH_LIBRARY || process.env.BINDERY_PARITY_LIBRARY || "library");
function epubs(dir: string, found: string[] = []): string[] {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) epubs(path, found);
    else if (/\.epub$/i.test(entry.name)) found.push(path);
  }
  return found;
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

if (!enabled) {
  it.skip("optional KEPUB benchmark (set BINDERY_BENCH=1)", () => {});
} else {
  it("reports staged KEPUB conversion timings for the largest library EPUB", { timeout: 180_000 }, async () => {
    const files = epubs(library);
    if (!files.length) { console.info(`KEPUB benchmark skipped: no EPUBs in ${library} (set BINDERY_BENCH_LIBRARY)`); return; }
    const largest = files.sort((a, b) => statSync(b).size - statSync(a).size)[0]!;
    const input = new Uint8Array(readFileSync(largest));
    const runs = [];
    for (let index = 0; index < 5; index++) {
      const start = performance.now();
      const result = await convertToKepubAsync(input);
      runs.push({ totalMs: performance.now() - start, ...result.stats });
    }
    const warm = runs.slice(1), syncStart = performance.now();
    const sync = convertToKepub(input);
    console.info(`KEPUB benchmark file=${largest} bytes=${input.byteLength} members=${sync.stats.entries}`);
    console.info(`KEPUB benchmark async median=${median(warm.map(run => run.totalMs)).toFixed(1)}ms runs=${warm.map(run => Math.round(run.totalMs)).join(",")}`);
    console.info(`KEPUB benchmark stages median=${JSON.stringify({
      unpackMs: +median(warm.map(run => run.unpackMs)).toFixed(1),
      opfMs: +median(warm.map(run => run.opfMs)).toFixed(1),
      inflateMs: +median(warm.map(run => run.inflateMs)).toFixed(1),
      htmlMs: +median(warm.map(run => run.htmlMs)).toFixed(1),
      transformMs: +median(warm.map(run => run.transformMs)).toFixed(1),
      compressMs: +median(warm.map(run => run.compressMs)).toFixed(1),
      packMs: +median(warm.map(run => run.packMs)).toFixed(1),
    })} outputBytes=${warm[0]!.outputBytes}`);
    console.info(`KEPUB benchmark sync=${(performance.now() - syncStart).toFixed(1)}ms packMs=${sync.stats.packMs.toFixed(1)}`);
  });
}
