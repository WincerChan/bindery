import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tokens = readFileSync("src/styles.css", "utf8");
const desktop = tokens.slice(tokens.indexOf(":root {"), tokens.indexOf("@media (max-width: 767px)"));
const phone = tokens.slice(tokens.indexOf("@media (max-width: 767px)"), tokens.indexOf("@layer base"));
const token = (name: string, mobile = false) => (mobile ? phone : desktop).match(new RegExp(`--intro-${name}:\\s*([^;]+);`))?.[1];
function styles(board: string, tag: string) {
  const html = readFileSync(`docs/design/prototype/${board}.dc.html`, "utf8");
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*style="([^"]+)"`, "g"))].map(([, style]) => Object.fromEntries(style!.split(";").filter(s => s.includes(":")).map(s => s.trim().split(/:\s*/))));
}

describe("intro token provenance (actual inline board styles)", () => {
  it("matches the main stack, type, action offset and visual widths", () => {
    const main = styles("Main", "section")[0]!;
    expect(token("pad-top")).toBe(main["padding-top"]);
    expect(token("row-gap")).toBe(main.gap);
    const title = styles("Main", "h1")[0]!;
    expect(token("title-line")).toBe(title["line-height"]);
    expect(token("title-weight")).toBe(title["font-weight"]);
    expect(token("cover-title-tracking")).toBe(title["letter-spacing"]);
    const text = styles("Main", "div").find(s => s.flex === "1 1 380px")!;
    expect(token("stack-gap")).toBe(text.gap);
    const actions = styles("Main", "div").find(s => s["margin-top"] === "6px")!;
    expect(token("actions-offset")).toBe(actions["margin-top"]);
    expect(token("action-gap")).toBe(actions.gap);
    const lead = styles("Main", "p").find(s => s["max-width"] === "520px")!;
    expect(token("lead-max")).toBe(lead["max-width"]);
    expect(token("lead-line")).toBe(lead["line-height"]);
    for (const [board, tag, name] of [["Main", "div", "cover"], ["Ingest", "figure", "page"], ["Tracker", "div", "reading"], ["Devices", "figure", "device"]]) {
      expect(styles(board!, tag!).some(s => s.flex === `0 1 ${token(`visual-${name}`)}`), board).toBe(true);
    }
  });
  it("does not flatten the documented subpage, guide, book and empty structures to 22px", () => {
    for (const board of ["SettingsRules", "SettingsThemes"]) {
      const intro = styles(board, "section")[0]!;
      expect(token("subpage-pad")).toBe(intro["padding-top"]);
      expect(token("subpage-stack")).toBe(intro.gap);
      expect(token("subpage-next")).toBe(styles(board, "main")[0]!.gap);
    }
    expect(token("guide-stack")).toBe(styles("DevicesConnect", "div").find(s => s.flex === "1 1 420px")!.gap);
    expect(token("guide-next")).toBe(styles("DevicesConnect", "main")[0]!.gap);
    expect(token("book-stack")).toBe(styles("BookDetail", "div").find(s => s.flex === "1 1 420px")!.gap);
    expect(token("book-back")).toBe(styles("BookDetail", "section")[0]!.gap);
    expect(token("book-next")).toBe(styles("BookDetail", "main")[0]!.gap);
    expect(token("empty-pad")).toBe(styles("IngestEmpty", "section")[0]!["padding-top"]);
    expect(token("empty-lead")).toBe(styles("IngestEmpty", "p").find(s => s["max-width"])!["max-width"]);
  });
  it("preserves the preview toolbar's explicit sizes and inherited normal line boxes", () => {
    const title = styles("DevicesPreview", "h1")[0]!;
    expect(token("topbar-title")).toBe(title["font-size"]);
    expect(token("topbar-title-margin")).toBe(title.margin);
    expect(token("topbar-line")).toBe(title["line-height"] || "normal");
    expect(token("eyebrow-line")).toBe(styles("Main", "p")[0]!["line-height"] || "normal");
    expect(token("topbar-back-pad")).toBe(styles("DevicesPreview", "a").find(s => s["padding-right"])!["padding-right"]);
    expect(token("topbar-next")).toBe(styles("DevicesPreview", "main")[0]!.gap);
  });
  it("matches phone typography and the explicitly drawn cover/book exceptions", () => {
    expect(token("stack-gap", true)).toBe(styles("MobileLibrary", "section")[0]!.gap);
    expect(token("title-line", true)).toBe(styles("MobileLibrary", "h1")[0]!["line-height"]);
    expect(token("lead-line", true)).toBe(styles("MobileLibrary", "p").find(s => s["line-height"])!["line-height"]);
    expect(token("cover-lead-gap", true)).toBe(styles("MobileLibrary", "div").find(s => s.flex === "1")!.gap);
    expect(token("book-stack", true)).toBe(styles("MobileBookDetail", "div").find(s => s.gap === "14px")!.gap);
    expect(token("book-line", true)).toBe(styles("MobileBookDetail", "p").find(s => s["font-size"] === "15px")!["line-height"]);
    expect(token("book-back", true)).toBe(styles("MobileBookDetail", "section")[0]!.gap);
  });
});
