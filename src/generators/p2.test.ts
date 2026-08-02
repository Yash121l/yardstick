import { describe, expect, it } from "vitest";
import { assertP2Invariants, generateP2 } from "./p2.js";
import { Rng } from "./rng.js";

describe("Rng", () => {
  it("is deterministic for a given seed", () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("differs across seeds", () => {
    expect(new Rng(1).next()).not.toBe(new Rng(2).next());
  });

  it("shuffles without losing or duplicating members", () => {
    const src = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = new Rng(7).shuffle(src);
    expect(out.slice().sort((x, y) => x - y)).toEqual(src);
    expect(src).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // input untouched
  });

  it("keeps int() inside the requested bounds", () => {
    const r = new Rng(99);
    for (let i = 0; i < 500; i++) {
      const v = r.int(3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
    }
  });

  it("refuses to sample more than it has", () => {
    expect(() => new Rng(1).sample([1, 2], 3)).toThrow();
  });
});

describe("generateP2", () => {
  it("is byte-identical for the same seed", () => {
    const a = generateP2(20260802);
    const b = generateP2(20260802);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("produces different text for a different seed", () => {
    const a = generateP2(1);
    const b = generateP2(2);
    expect(JSON.stringify(a.items)).not.toBe(JSON.stringify(b.items));
  });

  it("emits exactly 150 items", () => {
    expect(generateP2(20260802).items).toHaveLength(150);
  });

  it("passes its own invariants", () => {
    expect(() => assertP2Invariants(generateP2(20260802))).not.toThrow();
  });

  it("covers all four label sets", () => {
    const f = generateP2(20260802);
    const sets = new Set(f.items.map((i) => i.labelSet));
    expect([...sets].sort()).toEqual(["funding", "meeting", "signal", "thesis"]);
  });

  it("carries every trap type the report breaks down by", () => {
    const f = generateP2(20260802);
    const traps = new Set(f.items.map((i) => i.trapType));
    for (const t of ["none", "distractor", "unit-trap", "spelled-number", "absent"]) {
      expect(traps.has(t as never)).toBe(true);
    }
  });

  it("never asserts a round stage on a non-event", () => {
    const f = generateP2(20260802);
    for (const g of f.gold) {
      if (g.labelSet === "funding" && g.labels.is_funding_event === false) {
        expect(g.labels.round_stage).toBeNull();
      }
    }
  });

  it("has absent-trap items whose correct stage is null despite a real event", () => {
    const f = generateP2(20260802);
    const absent = f.items.filter((i) => i.trapType === "absent");
    expect(absent.length).toBeGreaterThanOrEqual(5);
    const goldById = new Map(f.gold.map((g) => [g.id, g]));
    for (const i of absent) {
      const g = goldById.get(i.id)!;
      expect(g.labels.is_funding_event).toBe(true);
      expect(g.labels.round_stage).toBeNull();
    }
  });

  it("includes INR amounts on non-India companies so is_india cannot be currency detection", () => {
    const f = generateP2(20260802);
    const goldById = new Map(f.gold.map((g) => [g.id, g]));
    const inrNonIndia = f.items.filter(
      (i) =>
        i.trapType === "unit-trap" &&
        i.text.includes("crore") &&
        goldById.get(i.id)?.labels.is_india === false,
    );
    expect(inrNonIndia.length).toBeGreaterThanOrEqual(3);
  });

  it("includes USD amounts on India companies", () => {
    const f = generateP2(20260802);
    const goldById = new Map(f.gold.map((g) => [g.id, g]));
    const usdIndia = f.items.filter(
      (i) =>
        i.trapType === "unit-trap" &&
        i.text.includes("million") &&
        goldById.get(i.id)?.labels.is_india === true,
    );
    expect(usdIndia.length).toBeGreaterThanOrEqual(3);
  });

  it("gives every item a unique id and a gold row", () => {
    const f = generateP2(20260802);
    const ids = f.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    const goldIds = new Set(f.gold.map((g) => g.id));
    for (const id of ids) expect(goldIds.has(id)).toBe(true);
  });

  it("catches a broken fixture set rather than shipping it", () => {
    const f = generateP2(20260802);
    // Simulate a generator regression that drops trap coverage.
    const broken = { ...f, items: f.items.filter((i) => i.trapType !== "absent") };
    expect(() => assertP2Invariants(broken)).toThrow(/absent|length mismatch/);
  });
});
