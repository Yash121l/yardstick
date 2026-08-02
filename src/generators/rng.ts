/**
 * Seeded PRNG. Same seed => byte-identical fixtures, forever.
 *
 * mulberry32: small, fast, well-distributed enough for fixture generation.
 * Deliberately NOT Math.random — regenerating fixtures must be reproducible.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from empty array");
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Fisher-Yates on a copy. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const a = out[i] as T;
      const b = out[j] as T;
      out[i] = b;
      out[j] = a;
    }
    return out;
  }

  bool(pTrue = 0.5): boolean {
    return this.next() < pTrue;
  }

  /** n distinct picks. Throws rather than looping forever if n is too large. */
  sample<T>(items: readonly T[], n: number): T[] {
    if (n > items.length) throw new Error(`cannot sample ${n} from ${items.length}`);
    return this.shuffle(items).slice(0, n);
  }
}
