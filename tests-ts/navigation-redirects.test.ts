import { beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { resolve } from "node:path";

let probe: typeof import("./fixtures/navigation-redirects");
beforeAll(async () => {
  const result = await build({ configFile: false, logLevel: "silent", plugins: [
    // Server-only modules stay out of the client probe, as in the real client build.
    { name: "redirects-client-boundary", enforce: "pre", resolveId: id => id === "../server/http" ? "\0redirects-http" : id === "../server/reader/service" ? "\0redirects-reader" : undefined,
      load: id => id === "\0redirects-http" ? "export const authenticatedRoute = handler => handler;" : id === "\0redirects-reader" ? "export const previewRedirect = () => null;" : undefined },
    solid({ ssr: true }),
  ], ssr: { noExternal: true }, build: { write: false, minify: false, ssr: resolve("tests-ts/fixtures/navigation-redirects.ts") } });
  const entry = (Array.isArray(result) ? result : [result]).flatMap(output => "output" in output ? output.output : []).find(output => output.type === "chunk" && output.isEntry);
  if (!entry || entry.type !== "chunk") throw new Error("Missing redirect probe");
  probe = await import(/* @vite-ignore */ "data:text/javascript;base64," + Buffer.from(entry.code).toString("base64"));
});
import { jobsSearch, jobsSheetOpen, jobsSheetTarget, legacyJobsTarget } from "../src/features/ingest/search";

describe("merged navigation compatibility", () => {
  it.each([
    ["", "/ingest?jobs_tab=all&jobs_page=1#jobs"],
    ["?tab=failed&page=2", "/ingest?jobs_tab=failed&jobs_page=2#jobs"],
    ["?tab=all&page=bad", "/ingest?jobs_tab=all&jobs_page=bad#jobs"],
    ["?page=", "/ingest?jobs_tab=all&jobs_page=#jobs"],
    ["?tab=x%26y&page=1.0", "/ingest?jobs_tab=x%26y&jobs_page=1.0#jobs"],
  ])("maps legacy jobs searches without losing pagination: %s", (search, target) => {
    expect(legacyJobsTarget(search)).toBe(target);
  });
  it.each(["bad", "1.5", "", "Infinity", "1e3"])("rejects malformed jobs_page %s", page => {
    expect(jobsSearch({ jobs_page: page }).invalid).toBe(true);
  });
  it("defaults to all/1 and accepts the old integer syntax", () => {
    expect(jobsSearch({})).toEqual({ tab: "all", page: 1, invalid: false });
    expect(jobsSearch({ jobs_tab: "failed", jobs_page: "+2.0" })).toEqual({ tab: "failed", page: 2, invalid: false });
  });
  it("opens for the tab parameter or jobs hash, and removes only sheet state on close", () => {
    expect(jobsSheetOpen("/ingest")).toBe(false); expect(jobsSheetOpen("/ingest?jobs_page=2")).toBe(false);
    expect(jobsSheetOpen("/ingest?jobs_tab=")).toBe(true); expect(jobsSheetOpen("/ingest#jobs")).toBe(true);
    expect(jobsSheetTarget("/ingest?keep=1&jobs_tab=failed&jobs_page=2#jobs", false)).toBe("/ingest?keep=1");
    expect(jobsSheetTarget("/ingest?jobs_tab=all&keep=1#other", false)).toBe("/ingest?keep=1#other");
    expect(jobsSheetTarget("/ingest?keep=1", true)).toBe("/ingest?keep=1&jobs_tab=all#jobs");
  });
  it.each([
    ["/jobs?tab=failed&page=2", "/ingest?jobs_tab=failed&jobs_page=2#jobs"],
    ["/archive", "/?scope=archived"],
  ])("redirects client navigation through the actual route beforeLoad: %s", async (entry, expected) => {
    expect(await probe.navigate(entry)).toBe(expected);
  });
  it.each([
    ["/kindle", "/devices"],
    ["/kindle/", "/devices"],
    ["/kindle/preview?book=a", "/devices/preview?book=a"],
  ])("redirects legacy device client navigation through beforeLoad: %s", async (entry, expected) => {
    expect(await probe.navigateDevice(entry)).toBe(expected);
    expect(probe.legacyDeviceTarget(entry)).toBe(entry === "/kindle/" ? "/devices/" : expected);
  });
  it.each([
    ["/book/abc/preview", "/book/abc/preview/0?resume=1"],
    ["/book/abc/preview?return_to=%2F%3Fpage%3D2", "/book/abc/preview/0?resume=1&return_to=%2F%3Fpage%3D2"],
    ["/book/abc/preview?return_to=https%3A%2F%2Fevil.example", "/book/abc/preview/0?resume=1"],
  ])("opens the reader from an in-app read link, resuming like the server redirect: %s", async (entry, expected) => {
    expect(await probe.navigateReader(entry)).toBe(expected);
  });
});
