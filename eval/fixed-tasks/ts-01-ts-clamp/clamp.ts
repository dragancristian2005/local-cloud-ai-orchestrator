/* Number helpers. */

export function clamp(n: number, lo: number, hi: number): number {
  if (lo > hi) {
    throw new RangeError("lo must not be greater than hi");
  }
  return Math.min(hi, Math.max(lo, n));
}

export function isBetween(n: number, lo: number, hi: number): boolean {
  return n >= lo && n <= hi;
}
