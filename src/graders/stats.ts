import { Rng } from "../generators/rng.js";

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx] ?? 0;
}

/**
 * Macro-averaged F1 over the classes that appear in gold.
 *
 * Macro rather than micro on purpose: a triage model that nails the majority
 * class and fails a rare one should not look good, and the rare classes here
 * (anti-thesis, board-call) are the expensive ones to get wrong.
 */
export function macroF1(pairs: { gold: string; pred: string | null }[]): number {
  const classes = [...new Set(pairs.map((p) => p.gold))];
  if (classes.length === 0) return 0;
  const f1s = classes.map((c) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const { gold, pred } of pairs) {
      if (gold === c && pred === c) tp++;
      else if (gold !== c && pred === c) fp++;
      else if (gold === c && pred !== c) fn++;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  });
  return mean(f1s);
}

export function accuracy(pairs: { gold: unknown; pred: unknown }[]): number {
  if (pairs.length === 0) return 0;
  const hit = pairs.filter((p) => p.gold === p.pred).length;
  return hit / pairs.length;
}

export interface ConfidenceInterval {
  point: number;
  lo: number;
  hi: number;
  n: number;
}

/**
 * Bootstrap 95% CI by resampling ITEMS (not attempts) with replacement.
 *
 * The report refuses to name a winner when two CIs overlap. On 25-150 items a
 * two-point delta is noise, and saying so is the whole point of computing this.
 */
export function bootstrapCI(values: number[], iterations = 2000, seed = 12345): ConfidenceInterval {
  const n = values.length;
  if (n === 0) return { point: 0, lo: 0, hi: 0, n: 0 };
  if (n === 1) {
    const v = values[0] as number;
    return { point: v, lo: v, hi: v, n: 1 };
  }
  const rng = new Rng(seed);
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += values[rng.int(0, n - 1)] as number;
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  return {
    point: mean(values),
    lo: means[Math.floor(0.025 * iterations)] ?? 0,
    hi: means[Math.min(iterations - 1, Math.floor(0.975 * iterations))] ?? 0,
    n,
  };
}

/** True when two CIs overlap — i.e. the difference is within noise. */
export function ciOverlap(a: ConfidenceInterval, b: ConfidenceInterval): boolean {
  return a.lo <= b.hi && b.lo <= a.hi;
}

/**
 * Fraction of items whose label changed across repeats.
 *
 * For a triage pipeline this matters more than raw accuracy: a model that is
 * 92% accurate but flips 8% of labels between identical calls cannot be trusted
 * to produce a stable queue.
 */
export function labelFlipRate(byItem: Map<string, string[]>): number {
  const multi = [...byItem.values()].filter((v) => v.length > 1);
  if (multi.length === 0) return 0;
  const flipped = multi.filter((v) => new Set(v).size > 1).length;
  return flipped / multi.length;
}
