import { describe, expect, it } from "vitest";
import { DEVICE_TYPESET, SCREEN_PANELS, convertMarginX, defaultReadingSettings, devicePresets, marginXPx, pageGeometry, previewEstimate, previewTarget, readingSettings } from "../src/client/devices/typeset";
import { EMPTY_SETTINGS, defaultProfile, generateProfileCss, profileSettings, DEFAULT_PROFILE_ID } from "../src/client/devices/profiles";

const kindleTarget = (model: string) => previewTarget("kindle", model);
const koboTarget = (model: string) => previewTarget("kobo", model);

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

  it("scales reading settings, keeps percent against the column and em against the baseline face", () => {
    expect(defaultReadingSettings("kindle")).toEqual({ margin: "narrow", scale: 1, lineHeight: 1.75 });
    expect(defaultReadingSettings("kobo")).toEqual({ margin: "min", scale: 1, lineHeight: 1.54 });
    expect(readingSettings("kindle", { margin: "missing", scale: 9, lineHeight: 0.2 })).toEqual({ margin: "narrow", scale: 1.6, lineHeight: 1 });
    expect(readingSettings("kobo", { margin: "min", scale: 0.75, lineHeight: 2.2 })).toEqual({ margin: "min", scale: 0.75, lineHeight: 2.2 });
    const reading = { ...defaultReadingSettings("kindle"), scale: 1.2 }, geometry = pageGeometry(kindleTarget("KPW3"), reading);
    expect(geometry.emPx).toBeCloseTo(66);
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
  const owner = (settings: Record<string, unknown> = {}) => ({ marginX: -4.9, marginXUnit: "percent", marginY: null, lineHeight: null, paragraphSpacing: null, textIndent: null, justify: null, fontFamily: null, customCss: "", stripFonts: false, stripImages: true, ...settings });
  it("keeps the owner's generated CSS byte-identical and accepts legacy device metadata", () => {
    const parsed = profileSettings({ deviceModel: "KPW3", kindleMargin: "narrow", ...owner() });
    expect(parsed).toEqual(owner({ stripPageMargins: false }));
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
  });
  it("has a global built-in profile with no device fields and no CSS", () => {
    const value = defaultProfile();
    expect(value.id).toBe(DEFAULT_PROFILE_ID);
    expect(value).not.toHaveProperty("deviceId");
    expect(value.settings).not.toHaveProperty("deviceModel");
    expect(generateProfileCss(value)).toBe("");
  });
});
