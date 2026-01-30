export type BasicStats = {
  count: number;
  min?: number;
  max?: number;
  mean?: number;
  std?: number;
  median?: number;
  mad?: number; // median absolute deviation
};

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function medianOfSorted(sorted: number[]): number | undefined {
  const n = sorted.length;
  if (n === 0) return undefined;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid];
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export class RollingWindow {
  private readonly maxSize: number;
  private values: number[] = [];

  constructor(maxSize: number) {
    this.maxSize = Math.max(8, Math.floor(maxSize));
  }

  size(): number {
    return this.values.length;
  }

  push(x: number): void {
    if (!Number.isFinite(x)) return;
    this.values.push(x);
    if (this.values.length > this.maxSize) {
      this.values.splice(0, this.values.length - this.maxSize);
    }
  }

  snapshot(): number[] {
    return this.values.slice();
  }

  quantile(q: number): number | undefined {
    const qq = clamp01(q);
    const v = this.values;
    if (v.length === 0) return undefined;
    const sorted = v.slice().sort((a, b) => a - b);
    if (sorted.length === 1) return sorted[0];
    const pos = (sorted.length - 1) * qq;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    const frac = pos - lo;
    return (sorted[lo]! * (1 - frac)) + (sorted[hi]! * frac);
  }

  stats(): BasicStats {
    const v = this.values;
    const n = v.length;
    if (n === 0) return { count: 0 };

    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const x of v) {
      if (x < min) min = x;
      if (x > max) max = x;
      sum += x;
    }
    const mean = sum / n;
    let ss = 0;
    for (const x of v) {
      const d = x - mean;
      ss += d * d;
    }
    const std = Math.sqrt(ss / Math.max(1, n - 1));

    const sorted = v.slice().sort((a, b) => a - b);
    const median = medianOfSorted(sorted);
    let mad: number | undefined;
    if (typeof median === "number") {
      const dev = sorted.map(x => Math.abs(x - median)).sort((a, b) => a - b);
      mad = medianOfSorted(dev);
    }

    return { count: n, min, max, mean, std, median, mad };
  }
}

