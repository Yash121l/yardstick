import { describe, expect, it } from "vitest";
import { accuracy, bootstrapCI, ciOverlap, labelFlipRate, macroF1, percentile } from "./stats.js";

describe("macroF1", () => {
  it("is 1 for perfect prediction", () => {
    expect(
      macroF1([
        { gold: "a", pred: "a" },
        { gold: "b", pred: "b" },
      ]),
    ).toBe(1);
  });

  it("is 0 when nothing is right", () => {
    expect(
      macroF1([
        { gold: "a", pred: "b" },
        { gold: "b", pred: "a" },
      ]),
    ).toBe(0);
  });

  it("punishes ignoring a rare class, unlike raw accuracy", () => {
    // 9 of class a, 1 of class b; model always says "a".
    const pairs = [
      ...Array.from({ length: 9 }, () => ({ gold: "a", pred: "a" })),
      { gold: "b", pred: "a" },
    ];
    expect(accuracy(pairs)).toBeCloseTo(0.9, 6);
    // Macro-F1 averages over classes, so the missed rare class halves it.
    expect(macroF1(pairs)).toBeLessThan(0.6);
  });

  it("treats a null prediction as its own wrong answer", () => {
    expect(macroF1([{ gold: "a", pred: null }])).toBe(0);
  });
});

describe("percentile", () => {
  it("returns the median", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });
  it("returns the max at p100", () => {
    expect(percentile([1, 9, 4], 100)).toBe(9);
  });
  it("is 0 for an empty set rather than NaN", () => {
    expect(percentile([], 95)).toBe(0);
  });
});

describe("bootstrapCI", () => {
  it("brackets the point estimate", () => {
    const ci = bootstrapCI([0, 1, 1, 1, 0, 1, 1, 0, 1, 1]);
    expect(ci.point).toBeCloseTo(0.7, 6);
    expect(ci.lo).toBeLessThanOrEqual(ci.point);
    expect(ci.hi).toBeGreaterThanOrEqual(ci.point);
  });

  it("is deterministic for a given seed", () => {
    const xs = [1, 0, 1, 1, 0, 1, 0, 1];
    expect(bootstrapCI(xs)).toEqual(bootstrapCI(xs));
  });

  it("collapses to a point for a single observation", () => {
    expect(bootstrapCI([0.5])).toEqual({ point: 0.5, lo: 0.5, hi: 0.5, n: 1 });
  });

  it("narrows as n grows", () => {
    const small = bootstrapCI(Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? 1 : 0)));
    const large = bootstrapCI(Array.from({ length: 400 }, (_, i) => (i % 2 === 0 ? 1 : 0)));
    expect(large.hi - large.lo).toBeLessThan(small.hi - small.lo);
  });

  it("detects overlap, which is what stops a false winner being declared", () => {
    const a = bootstrapCI(Array.from({ length: 25 }, (_, i) => (i < 20 ? 1 : 0)));
    const b = bootstrapCI(Array.from({ length: 25 }, (_, i) => (i < 21 ? 1 : 0)));
    // 80% vs 84% on 25 items is noise, and the CIs must say so.
    expect(ciOverlap(a, b)).toBe(true);
  });

  it("separates genuinely different distributions", () => {
    const a = bootstrapCI(Array.from({ length: 200 }, (_, i) => (i < 40 ? 1 : 0)));
    const b = bootstrapCI(Array.from({ length: 200 }, (_, i) => (i < 180 ? 1 : 0)));
    expect(ciOverlap(a, b)).toBe(false);
  });
});

describe("labelFlipRate", () => {
  it("is 0 when every repeat agrees", () => {
    expect(
      labelFlipRate(
        new Map([
          ["a", ["x", "x"]],
          ["b", ["y", "y"]],
        ]),
      ),
    ).toBe(0);
  });

  it("counts an item whose repeats disagree", () => {
    expect(
      labelFlipRate(
        new Map([
          ["a", ["x", "y"]],
          ["b", ["y", "y"]],
        ]),
      ),
    ).toBe(0.5);
  });

  it("ignores items with only one sample rather than calling them stable", () => {
    expect(labelFlipRate(new Map([["a", ["x"]]]))).toBe(0);
  });
});
