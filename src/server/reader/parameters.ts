/** Pydantic int parameters accept zero decimal fractions and digit separators. */
export function integerParameter(raw: string): number | null {
  const integer = bigIntegerParameter(raw);
  if (integer === null || integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < BigInt(Number.MIN_SAFE_INTEGER)) return null;
  return Number(integer);
}
export function bigIntegerParameter(raw: string): bigint | null {
  const normalized = raw.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  if (!/^[+-]?\d(?:_?\d)*(?:\.0(?:_?0)*)?$/.test(normalized)) return null;
  const integer = normalized.replaceAll("_", "").split(".")[0];
  if (integer.replace(/^[+-]/, "").length > 4300) return null;
  return BigInt(integer);
}
