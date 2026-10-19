const MB = 1024 * 1024, DEFAULT_OVERHEAD_MS = 300, DEFAULT_MS_PER_MB = 80;
const MAX_DURATION_MS = 120_000;
interface Sample { megabytes: number; milliseconds: number }

/** Session-local measurements; WASM has no byte/percentage progress callback. */
export class ConversionEstimate {
  private samples: Sample[] = [];
  durationMs(inputBytes: number) {
    const megabytes = Number.isSafeInteger(inputBytes) && inputBytes > 0 ? inputBytes / MB : 0;
    const baseline = DEFAULT_OVERHEAD_MS + DEFAULT_MS_PER_MB * megabytes;
    // A tiny book measures mostly fixed overhead. Only nearby sizes can justify
    // slow estimates before there is enough size variation to fit a slope.
    const nearby = this.samples.filter(sample => sample.megabytes >= megabytes / 2 && sample.megabytes <= megabytes * 2);
    const local = nearby.length ? nearby.reduce((sum, sample) => sum + Math.max(50, sample.milliseconds + DEFAULT_MS_PER_MB * (megabytes - sample.megabytes)), 0) / nearby.length * 0.9 : undefined;
    let estimate = local ?? baseline;
    if (this.samples.length >= 2) {
      const sizes = this.samples.map(sample => sample.megabytes), largest = Math.max(...sizes);
      // Avoid an unstable fit to nearly identical sizes.
      if (largest - Math.min(...sizes) >= Math.max(0.25, largest * 0.1)) {
        const meanSize = sizes.reduce((sum, value) => sum + value, 0) / sizes.length;
        const meanMs = this.samples.reduce((sum, sample) => sum + sample.milliseconds, 0) / sizes.length;
        const variance = sizes.reduce((sum, value) => sum + (value - meanSize) ** 2, 0);
        const covariance = this.samples.reduce((sum, sample) => sum + (sample.megabytes - meanSize) * (sample.milliseconds - meanMs), 0);
        let rate = Math.max(0, covariance / variance), overhead = meanMs - rate * meanSize;
        if (overhead < 0) {
          overhead = 0;
          rate = this.samples.reduce((sum, sample) => sum + sample.megabytes * sample.milliseconds, 0) / sizes.reduce((sum, value) => sum + value ** 2, 0);
        }
        estimate = (Math.min(5000, overhead) + Math.min(10_000, rate) * megabytes) * 0.9;
      }
    }
    // Bias measured estimates slightly low, and never extrapolate a slow small
    // sample beyond 3× the default without measurements of comparable books.
    return Math.max(50, Math.min(MAX_DURATION_MS, estimate, Math.max(3 * baseline, local ?? 0)));
  }
  record(inputBytes: number, milliseconds: number) {
    if (!Number.isSafeInteger(inputBytes) || inputBytes <= 0 || !Number.isFinite(milliseconds) || milliseconds <= 0) return;
    this.samples.push({ megabytes: inputBytes / MB, milliseconds: Math.min(MAX_DURATION_MS, milliseconds) });
    if (this.samples.length > 32) this.samples.shift();
  }
}
