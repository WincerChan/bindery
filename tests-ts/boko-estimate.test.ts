import { describe, expect, it } from "vitest";
import { ConversionEstimate } from "../src/client/boko/estimate";

const MB = 1024 * 1024, defaultMs = (bytes: number) => 300 + 80 * bytes / MB;
describe("conversion duration estimates", () => {
  it("includes fixed overhead by default and does not extrapolate one tiny book's byte rate", () => {
    const estimate = new ConversionEstimate(), tiny = 40 * 1024, large = 10867355;
    expect(estimate.durationMs(tiny)).toBeCloseTo(defaultMs(tiny));
    expect(estimate.durationMs(large)).toBeCloseTo(defaultMs(large));
    estimate.record(tiny, 120);
    expect(estimate.durationMs(large)).toBeCloseTo(defaultMs(large));
    expect(estimate.durationMs(large)).toBeLessThan(1200);
  });

  it("fits overhead and per-MB cost across mixed sizes, regardless of sample order", () => {
    const samples = [[40 * 1024, 340], [10 * MB, 1000], [2 * MB, 470]];
    for (const ordered of [samples, samples.slice().reverse()]) {
      const estimate = new ConversionEstimate();
      for (const [bytes, ms] of ordered) estimate.record(bytes, ms);
      expect(estimate.durationMs(10 * MB)).toBeGreaterThan(800);
      expect(estimate.durationMs(10 * MB)).toBeLessThan(1000);
      expect(estimate.durationMs(20 * MB)).toBeGreaterThan(1400);
      expect(estimate.durationMs(20 * MB)).toBeLessThan(1900);
    }
  });

  it("uses repeated similar-size measurements without inventing a byte rate", () => {
    const estimate = new ConversionEstimate();
    estimate.record(10 * MB, 8000); estimate.record(10 * MB, 10_000);
    expect(estimate.durationMs(10 * MB)).toBeCloseTo(8100);
    expect(estimate.durationMs(10 * MB)).toBeGreaterThan(3 * defaultMs(10 * MB));
    expect(estimate.durationMs(100 * MB)).toBe(defaultMs(100 * MB));
  });

  it("caps extrapolated slow measurements at three times the default without nearby evidence", () => {
    const estimate = new ConversionEstimate(), large = 10 * MB;
    estimate.record(40 * 1024, 5000); estimate.record(0.5 * MB, 7000);
    expect(estimate.durationMs(large)).toBeLessThanOrEqual(3 * defaultMs(large));
    estimate.record(large, 20_000);
    expect(estimate.durationMs(large)).toBeGreaterThan(3 * defaultMs(large));
    expect(estimate.durationMs(large)).toBeLessThanOrEqual(20_000);
  });

  it("keeps noisy, negative-slope and negative-intercept fits finite and bounded", () => {
    for (const samples of [[[MB, 3000], [10 * MB, 500]], [[MB, 10], [10 * MB, 20_000]], [[MB, 1], [MB + 1, 120_000]]]) {
      const estimate = new ConversionEstimate();
      for (const [bytes, ms] of samples) estimate.record(bytes, ms);
      for (const bytes of [40 * 1024, MB, 10 * MB, 100 * MB]) {
        expect(estimate.durationMs(bytes)).toBeGreaterThanOrEqual(50);
        expect(estimate.durationMs(bytes)).toBeLessThanOrEqual(120_000);
      }
    }
  });

  it("ignores invalid samples and bounds extreme durations", () => {
    const estimate = new ConversionEstimate();
    for (const [bytes, ms] of [[0, 100], [-1, 100], [Infinity, 100], [NaN, 100], [MB, 0], [MB, -1], [MB, Infinity], [MB, NaN]]) estimate.record(bytes, ms);
    expect(estimate.durationMs(10 * MB)).toBe(defaultMs(10 * MB));
    estimate.record(MB, Number.MAX_VALUE);
    expect(estimate.durationMs(MB)).toBeLessThanOrEqual(120_000);
    expect(estimate.durationMs(Infinity)).toBe(300);
  });
});
