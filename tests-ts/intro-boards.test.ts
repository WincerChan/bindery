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
const introText = (board: string) => styles(board, "div").find(style => /^1 1 (?:360|380|420)px$/.test(style.flex || ""));
const actionRow = (board: string) => styles(board, "div").find(style => style["margin-top"] === token("actions-offset"));
const mainSection = (board: string) => styles(board, "section")[0]!;

describe("intro rhythm provenance (actual inline board styles)", () => {
  it("uses one desktop stack, action offset and action gap across main intros", () => {
    expect(token("stack-gap")).toBe("22px");
    expect(token("actions-offset")).toBe("6px");
    expect(token("action-gap")).toBe("12px");
    for (const board of ["Main", "Ingest", "Tracker", "Vocabulary", "Devices", "SettingsSecurity"]) {
      expect(introText(board)?.gap, board).toBe(token("stack-gap"));
    }
    for (const board of ["Main", "Ingest", "Tracker", "Devices", "SettingsSecurity"]) {
      expect(actionRow(board)?.["margin-top"], board).toBe(token("actions-offset"));
      if (actionRow(board)?.gap) expect(actionRow(board)?.gap, board).toBe(token("action-gap"));
    }
    // Vocabulary's status and actions share one structural row, as the app's controls wrapper does.
    expect(styles("Vocabulary", "p").find(style => style["flex-wrap"] === "wrap" && style.gap === "8px 14px")).toBeTruthy();
    expect(token("status-offset")).toBe("0px");
  });

  it("keeps back-linked subpages, title-only, guide and book on the same stack rhythm", () => {
    for (const board of ["SettingsRules", "SettingsThemes"]) {
      expect(mainSection(board).gap, board).toBe(token("stack-gap"));
      expect(mainSection(board)["padding-top"], board).toBe(token("subpage-pad"));
    }
    expect(mainSection("SettingsHub").gap).toBe(token("stack-gap"));
    expect(mainSection("SettingsHub")["padding-top"]).toBe("40px");

    expect(introText("DevicesConnect")?.gap).toBe(token("stack-gap"));
    expect(actionRow("DevicesConnect")?.["margin-top"]).toBe(token("actions-offset"));
    expect(actionRow("DevicesConnect")?.gap).toBe(token("action-gap"));
    expect(styles("DevicesConnect", "ol")[0]!.gap).toBe("18px"); // steps are structure, not the stack scale

    expect(introText("BookDetail")?.gap).toBe(token("stack-gap"));
    expect(mainSection("BookDetail").gap).toBe(token("book-back"));
    expect(styles("BookDetail", "div").find(style => style["max-width"] === "460px")?.["margin-top"]).toBeUndefined();
    expect(actionRow("BookDetail")?.["margin-top"]).toBe(token("actions-offset"));
    expect(styles("BookDetail", "main")[0]!.gap).toBe(token("book-next"));
  });

  it("uses the phone rhythm in every mobile intro, including nested covers and book text", () => {
    expect(token("stack-gap", true)).toBe("16px");
    expect(token("actions-offset", true)).toBe("0px");
    for (const board of ["MobileIngest", "MobileTracker", "MobileVocabulary", "MobileLibrary", "MobileDevices"]) {
      expect(mainSection(board).gap, board).toBe(token("stack-gap", true));
    }
    expect(styles("MobileLibrary", "div").find(style => style.flex === "1" && style["flex-direction"] === "column")?.gap).toBe(token("stack-gap", true));
    expect(styles("MobileBookDetail", "div").find(style => style.gap === token("stack-gap", true))?.gap).toBe(token("stack-gap", true));
    expect(mainSection("MobileBookDetail").gap).toBe(token("book-back", true));
    expect(styles("MobileBookDetail", "div").find(style => style["max-width"] === undefined && style.gap === "10px")?.["margin-top"]).toBeUndefined();
    expect(styles("MobileBookDetail", "a").find(style => style.height === "48px")?.["margin-top"]).toBeUndefined();
    expect(styles("MobileBookDetail", "main")[0]!.gap).toBe("32px");
    expect(token("book-next", true)).toBe("var(--space-section)");
  });

  it("shares intro type except the explicit preview topbar row", () => {
    expect(token("title-line")).toBe("1.25");
    expect(token("title-line", true)).toBe("1.3");
    expect(token("lead-line")).toBe("1.85");
    expect(token("lead-line", true)).toBe("1.8");
    expect(token("title-tracking")).toBe("0.01em");
    expect(token("topbar-title")).toBe("30px");
    for (const board of ["Main", "Ingest", "Tracker", "Vocabulary", "Devices", "SettingsRules", "SettingsThemes", "SettingsSecurity", "BookDetail", "DevicesConnect"]) {
      const title = styles(board, "h1")[0]!;
      expect(title["font-size"], board).toBe("46px");
      expect(title["line-height"], board).toBe(token("title-line"));
    }
    expect(token("topbar-title")).toBe(styles("DevicesPreview", "h1")[0]!["font-size"]);
    expect(token("topbar-line")).toBe(styles("DevicesPreview", "h1")[0]!["line-height"] || "normal");
  });

  it("has no page-specific stack/action/type tokens left", () => {
    for (const name of ["subpage-stack", "guide-stack", "book-stack", "guide-actions", "book-actions", "book-status", "book-line", "cover-lead-gap", "cover-title-tracking", "editor-title", "editor-line"]) {
      expect(tokens, name).not.toMatch(new RegExp(`--intro-${name}:`));
    }
  });
});
