import { describe, expect, it } from "vitest";
import { DEVICE_TYPESET, SCREEN_PANELS, convertMarginX, defaultReadingSettings, devicePresets, marginXPx, pageGeometry, previewEstimate, previewTarget, readingSettings } from "../src/client/devices/typeset";
import { EMPTY_SETTINGS, defaultProfile, generateProfileCss, profileSettings, DEFAULT_PROFILE_ID } from "../src/client/devices/profiles";
import { PreviewDocument } from "../src/features/devices/preview/frame";
import { previewDocumentFixture } from "./support/kindle-preview-dom";

const kindleTarget = (model: string) => previewTarget("kindle", model);
const koboTarget = (model: string) => previewTarget("kobo", model);
const koboGeometry = (model = "libra2") => pageGeometry(koboTarget(model), defaultReadingSettings("kobo"));

describe("panels, device kinds and preview geometry", () => {
  it("maps every model to a panel and keeps unknown models on the Kindle/Kobo fallback", () => {
    expect(kindleTarget("KPW3")).toMatchObject({ panelId: "1072x1448", fallbackPanel: false, panel: SCREEN_PANELS["1072x1448"] });
    expect(kindleTarget("KO3")).toMatchObject({ panelId: "1264x1680", fallbackPanel: false });
    expect(kindleTarget("other")).toMatchObject({ panelId: "1072x1448", fallbackPanel: true, panel: SCREEN_PANELS["1072x1448"] });
    expect(koboTarget("unknown")).toMatchObject({ panelId: "1264x1680", fallbackPanel: true });
    expect(koboTarget("nia")).toMatchObject({ panelId: "758x1024", fallbackPanel: false });
    expect(koboTarget("mini").panel).toMatchObject({ width: 600, height: 800, ppi: 167 });
  });

  it("matches today's KPW3 narrow and Libra 2 minimum pages field by field", () => {
    expect(pageGeometry(kindleTarget("KPW3"), defaultReadingSettings("kindle"))).toMatchObject({
      width: 1072, height: 1448, emPx: 55, lineHeight: 1.75, side: 80, top: 52, bottom: 70, column: 912, gap: 160, contentHeight: 1326,
      fontFamily: "serif", bookInsets: false, readerLineSpacingOverridesBook: false, measured: true,
    });
    expect(pageGeometry(koboTarget("libra2"), defaultReadingSettings("kobo"))).toMatchObject({
      width: 1264, height: 1680, emPx: 53.5, lineHeight: 1.54, side: 40, top: 96, bottom: 160, column: 1184, gap: 80, contentHeight: 1424,
      fontFamily: "sans-serif", bookInsets: true, readerLineSpacingOverridesBook: true, measured: true,
    });
    expect(pageGeometry(koboTarget("libra2"), defaultReadingSettings("kobo")).fallbackSources).toBe(DEVICE_TYPESET.kobo.fallbackSources);
  });

  it("uses ppi scaling: KO3 keeps KPW3 pixel measurements and Nia shrinks to 28 px margins", () => {
    const ko3 = pageGeometry(kindleTarget("KO3"), defaultReadingSettings("kindle"));
    expect(ko3).toMatchObject({ emPx: 55, side: 80, top: 52, bottom: 70, column: 1104, measured: false });
    const nia = pageGeometry(koboTarget("nia"), defaultReadingSettings("kobo"));
    expect(devicePresets("kobo", SCREEN_PANELS["758x1024"])).toEqual([{ id: "min", label: "最小", px: 28 }]);
    expect(nia).toMatchObject({ side: 28, top: 68, bottom: 113 });
    expect(nia.emPx).toBeCloseTo(53.5 * 212 / 300);
  });

  it("keeps only the device margin preset, percent against the column and em against the measured face", () => {
    expect(defaultReadingSettings("kindle")).toEqual({ margin: "narrow" });
    expect(defaultReadingSettings("kobo")).toEqual({ margin: "min" });
    expect(readingSettings("kindle", { margin: "missing" })).toEqual({ margin: "narrow" });
    expect(readingSettings("kindle", { margin: "wide" })).toEqual({ margin: "wide" });
    const geometry = pageGeometry(kindleTarget("KPW3"), defaultReadingSettings("kindle"));
    expect(geometry.emPx).toBe(55);
    expect(marginXPx(geometry, 1, "em")).toBe(55);
    expect(marginXPx(geometry, 10, "percent")).toBeCloseTo(91.2);
    expect(convertMarginX(geometry, -4.9, "percent", "em")).toBeCloseTo(-0.8125, 4);
    expect(convertMarginX(geometry, -0.8, "em", "percent")).toBeCloseTo(-4.8245, 3);
  });

  it("estimates the whole-character line and page count from the visible column", () => {
    const geometry = pageGeometry(kindleTarget("KPW3"), defaultReadingSettings("kindle"));
    expect(previewEstimate(geometry, { marginX: null, marginXUnit: "percent" })).toEqual({ sideMarginPx: 80, contentWidthPx: 912, charsPerLine: 16, linesPerPage: 13, measured: true });
    expect(previewEstimate(geometry, { marginX: -4.9, marginXUnit: "percent" })).toMatchObject({ sideMarginPx: 80 - 0.049 * 912, charsPerLine: 18, linesPerPage: 13 });
    expect(previewEstimate(pageGeometry(kindleTarget("KO3"), defaultReadingSettings("kindle")), { marginX: null, marginXUnit: "percent" }).measured).toBe(false);
  });
});

describe("global typesetting profiles", () => {
  const owner = (settings: Record<string, unknown> = {}) => ({ marginX: -4.9, marginXUnit: "percent", marginY: null, lineHeight: null, paragraphSpacing: null, textIndent: null, fontFamily: null, customCss: "", stripFonts: false, stripImages: true, ...settings });
  it("keeps the owner's generated CSS byte-identical and accepts legacy device metadata", () => {
    const parsed = profileSettings({ deviceModel: "KPW3", kindleMargin: "narrow", ...owner() });
    expect(parsed).toEqual(owner({ stripPageMargins: false, stripLineHeight: false, stripParagraphSpacing: false }));
    expect(generateProfileCss({ id: "custom", name: "我的排版", builtIn: false, settings: parsed })).toBe("body > * {\n  margin-left: -4.9% !important;\n  margin-right: -4.9% !important;\n}");
    expect(() => profileSettings({ ...owner(), deviceModel: 3 })).toThrow("deviceModel");
    expect(profileSettings({ ...owner({ marginX: -0.8, marginXUnit: undefined }) }).marginXUnit).toBe("em");
  });
  it("accepts −4.9% and −35% but rejects −41%", () => {
    expect(profileSettings(owner({ marginX: -4.9 })).marginX).toBe(-4.9);
    expect(profileSettings(owner({ marginX: -35 })).marginX).toBe(-35);
    expect(() => profileSettings(owner({ marginX: -41 }))).toThrow("−40–40%");
    expect(() => profileSettings(owner({ marginX: 20.1, marginXUnit: "em" }))).toThrow("−20–20em");
    expect(EMPTY_SETTINGS.stripPageMargins).toBe(false);
    expect(EMPTY_SETTINGS.stripLineHeight).toBe(false); expect(EMPTY_SETTINGS.stripParagraphSpacing).toBe(false);
  });
  it("has a global built-in profile with no device fields and no CSS", () => {
    const value = defaultProfile();
    expect(value.id).toBe(DEFAULT_PROFILE_ID);
    expect(value).not.toHaveProperty("deviceId");
    expect(value.settings).not.toHaveProperty("deviceModel");
    expect(generateProfileCss(value)).toBe("");
  });
});

describe("Kobo approximate preview settings", () => {
  it("matches the Libra 2 measurement at the defaults", () => {
    const geometry = pageGeometry(koboTarget("libra2"), defaultReadingSettings("kobo"));
    expect(previewEstimate(geometry, { marginX: null, marginXUnit: "percent" })).toMatchObject({ charsPerLine: 22, linesPerPage: 17 });
    expect(geometry).toMatchObject({ emPx: 53.5, lineHeight: 1.54, width: 1264, height: 1680, column: 1184 });
  });
  it("previews at the measured font size and line spacing, ignoring older stored values", () => {
    const geometry = pageGeometry(koboTarget("libra2"), readingSettings("kobo", { margin: "min", scale: 1.2, lineHeight: 1.8 }));
    expect(geometry).toMatchObject({ emPx: 53.5, lineHeight: 1.54, column: 1184, contentHeight: 1424 });
    expect(readingSettings("kobo", { margin: "bogus", scale: 9 })).toEqual({ margin: "min" });
    expect(readingSettings("kobo", "garbage")).toEqual(defaultReadingSettings("kobo"));
  });
});

it("keeps neighbouring page text outside the visible Kobo window with a -20% profile margin", () => {
  const target = previewDocumentFixture(), geometry = koboGeometry(), pitch = 2 * geometry.width, scroll = (page: number) => (page - 1) * pitch;
  const side = geometry.side + marginXPx(geometry, -20, "percent"), p1 = target.document.createElement("p"), p2 = target.document.createElement("p");
  const first = target.document.createTextNode("页"), second = target.document.createTextNode("邻");
  p1.appendChild(first); p2.appendChild(second); target.body.appendChild(p1); target.body.appendChild(p2);
  const rect = (node: Text) => ({ left: (node === first ? 0 : pitch) + side, right: (node === first ? 0 : pitch) + side + 55, top: 0, bottom: 10 });
  const inWindow = (node: Text, start: number) => { const value = rect(node); return value.right > start && value.left < start + geometry.width; };
  target.setExtent(2 * pitch - 80);
  const preview = new PreviewDocument(target.document); preview.setGeometry(geometry);
  preview.open(1); expect(target.root.scrollLeft).toBe(scroll(1)); expect(inWindow(second, scroll(1))).toBe(false);
  preview.open(2); expect(target.root.scrollLeft).toBe(scroll(2)); expect(inWindow(first, scroll(2))).toBe(false);
  preview.destroy();
});

it("keeps Kobo's device line height before the profile and only applies its font when chosen", async () => {
  const target = previewDocumentFixture(), { document, head } = target, book = document.createElement("style");
  book.textContent = "body { line-height: 2; }"; head.appendChild(book);
  const preview = new PreviewDocument(document), base = head.firstChild!;
  preview.setGeometry(koboGeometry());
  expect(base.textContent).toContain("html body, html body * { line-height: 1.54 !important; }");
  const profile = (settings: Record<string, unknown>) => generateProfileCss({ id: "custom", name: "正文", builtIn: false, settings: { ...EMPTY_SETTINGS, ...settings } });
  await preview.update(profile({ lineHeight: 1.8 }), null);
  const sheet = head.lastChild!;
  expect(Array.from(head.childNodes).indexOf(base)).toBeLessThan(Array.from(head.childNodes).indexOf(book));
  expect(Array.from(head.childNodes).indexOf(book)).toBeLessThan(Array.from(head.childNodes).indexOf(sheet));
  expect(sheet.textContent).toContain("line-height: 1.8;"); expect(sheet.textContent).not.toContain("!important;\n  line-height");
  await preview.update(profile({ lineHeight: 1.8, fontFamily: "Book" }), null);
  expect(sheet.textContent).toContain('font-family: "Book"');
  preview.destroy();
});
