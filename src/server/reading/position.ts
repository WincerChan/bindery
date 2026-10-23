export interface ReadingPosition { section: number | null; section_fraction: number | null; percent: number }
export const clampFraction = (value: number) => Math.max(0, Math.min(1, value));
export const clampPercent = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
/** Distribute a whole-book percent over section byte sizes when the device has no usable chapter path. */
export function percentFallback(sections: { item_path: string }[], sizes: Map<string, number>, percent: number): Pick<ReadingPosition, "section" | "section_fraction"> {
  if (!sections.length) return { section: null, section_fraction: null };
  const weights = sections.map(section => Math.max(0, sizes.get(section.item_path) ?? 0)), total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!total) return { section: 0, section_fraction: 0 };
  const target = percent / 100 * total;
  let start = 0;
  for (let index = 0; index < weights.length; index++) {
    const end = start + weights[index];
    if (target < end || index === weights.length - 1) return { section: index, section_fraction: weights[index] ? clampFraction((target - start) / weights[index]) : 0 };
    start = end;
  }
  return { section: sections.length - 1, section_fraction: 1 };
}
