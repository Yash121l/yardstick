import { describe, expect, it } from "vitest";
import {
  compareQuantity,
  extractNumericTokens,
  normalizeQuantity,
  parseNumberWords,
  parseQuantity,
} from "./normalize.js";

describe("parseNumberWords", () => {
  it("reads simple words", () => {
    expect(parseNumberWords("twelve")).toBe(12);
    expect(parseNumberWords("forty")).toBe(40);
  });
  it("reads hyphenated compounds", () => {
    expect(parseNumberWords("twenty-five")).toBe(25);
    expect(parseNumberWords("forty seven")).toBe(47);
  });
  it("reads hundreds", () => {
    expect(parseNumberWords("three hundred")).toBe(300);
  });
  it("returns null for non-numbers", () => {
    expect(parseNumberWords("runway")).toBeNull();
    expect(parseNumberWords("")).toBeNull();
  });
});

describe("parseQuantity — Indian scales", () => {
  it("converts crore to INR base units", () => {
    expect(parseQuantity("₹8.1 crore")).toEqual({ value: 81_000_000, unit: "INR" });
  });
  it("converts lakh to INR base units", () => {
    expect(parseQuantity("₹12 lakh")).toEqual({ value: 1_200_000, unit: "INR" });
  });
  it("treats a bare crore figure as INR", () => {
    expect(parseQuantity("8.1 crore")).toEqual({ value: 81_000_000, unit: "INR" });
  });
  it("reads a spelled-out crore amount", () => {
    expect(parseQuantity("about twelve crore")).toEqual({ value: 120_000_000, unit: "INR" });
  });
  it("reads Rs as a rupee marker", () => {
    expect(parseQuantity("Rs 40 crore")).toEqual({ value: 400_000_000, unit: "INR" });
  });
});

describe("parseQuantity — western scales", () => {
  it("converts million USD", () => {
    expect(parseQuantity("$9 million")).toEqual({ value: 9_000_000, unit: "USD" });
  });
  it("handles $9M shorthand", () => {
    expect(parseQuantity("$9M")).toEqual({ value: 9_000_000, unit: "USD" });
  });
  it("handles grouped thousands", () => {
    expect(parseQuantity("$1,250,000")).toEqual({ value: 1_250_000, unit: "USD" });
  });
});

describe("parseQuantity — the percent vs percentage-point trap", () => {
  it("reads a percentage", () => {
    expect(parseQuantity("2.1%")).toEqual({ value: 2.1, unit: "pct" });
  });
  it("reads percentage points as a DIFFERENT unit", () => {
    expect(parseQuantity("3 pp")).toEqual({ value: 3, unit: "pp" });
    expect(parseQuantity("3 percentage points")).toEqual({ value: 3, unit: "pp" });
  });
  it("does not let pct and pp compare equal", () => {
    const c = compareQuantity(parseQuantity("3%"), parseQuantity("3 pp"));
    expect(c.valueMatches).toBe(true);
    expect(c.unitMatches).toBe(false);
    expect(c.match).toBe(false);
  });
});

describe("parseQuantity — a rate is money, not a duration", () => {
  // Regression: "₹59 lakh per month" was parsed as 59 MONTHS because the
  // duration check ran before the currency check. Caught by a live P1 run.
  it("reads a monthly burn in lakh as currency", () => {
    expect(parseQuantity("₹59 lakh per month")).toEqual({ value: 5_900_000, unit: "INR" });
  });
  it("reads a monthly burn in dollars as currency", () => {
    expect(parseQuantity("$250k a month")).toEqual({ value: 250_000, unit: "USD" });
  });
  it("reads an annual figure as currency, not 12 months", () => {
    expect(parseQuantity("$4 million per year")).toEqual({ value: 4_000_000, unit: "USD" });
  });
  it("still reads a bare duration as months", () => {
    expect(parseQuantity("14 months")).toEqual({ value: 14, unit: "months" });
  });
});

describe("parseQuantity — durations and counts", () => {
  it("reads months", () => {
    expect(parseQuantity("14 months")).toEqual({ value: 14, unit: "months" });
  });
  it("reads spelled-out months", () => {
    expect(parseQuantity("fourteen months")).toEqual({ value: 14, unit: "months" });
  });
  it("converts years to months so a runway comparison works", () => {
    expect(parseQuantity("2 years")).toEqual({ value: 24, unit: "months" });
  });
  it("reads headcount", () => {
    expect(parseQuantity("about forty-seven people")).toEqual({ value: 47, unit: "count" });
    expect(parseQuantity("47 employees")).toEqual({ value: 47, unit: "count" });
  });
  it("returns unknown for an unlabelled bare number", () => {
    expect(parseQuantity("47")).toEqual({ value: 47, unit: "unknown" });
  });
  it("returns a null value for text with no magnitude", () => {
    expect(parseQuantity("no data")).toEqual({ value: null, unit: "unknown" });
  });
});

describe("normalizeQuantity — model output shapes", () => {
  it("combines a numeric value with a unit string carrying the scale", () => {
    expect(normalizeQuantity(8.1, "INR crore")).toEqual({ value: 81_000_000, unit: "INR" });
  });
  it("handles the value already being in base units", () => {
    expect(normalizeQuantity(81_000_000, "INR")).toEqual({ value: 81_000_000, unit: "INR" });
  });
  it("handles a stringified value", () => {
    expect(normalizeQuantity("₹8.1 crore", "")).toEqual({ value: 81_000_000, unit: "INR" });
  });
  it("returns a null value for null", () => {
    expect(normalizeQuantity(null, null)).toEqual({ value: null, unit: "unknown" });
  });
  it("keeps an unlabelled number rather than discarding it", () => {
    expect(normalizeQuantity(47, "")).toEqual({ value: 47, unit: "unknown" });
  });
});

describe("compareQuantity", () => {
  const inr = (v: number) => ({ value: v, unit: "INR" as const });

  it("matches identical quantities", () => {
    expect(compareQuantity(inr(81_000_000), inr(81_000_000)).match).toBe(true);
  });
  it("tolerates rounding within 0.5%", () => {
    expect(compareQuantity(inr(81_000_000), inr(81_100_000)).match).toBe(true);
  });
  it("rejects a materially different figure", () => {
    expect(compareQuantity(inr(81_000_000), inr(84_000_000)).match).toBe(false);
  });
  it("rejects the right number in the wrong currency", () => {
    const c = compareQuantity({ value: 81_000_000, unit: "USD" }, inr(81_000_000));
    expect(c.valueMatches).toBe(true);
    expect(c.match).toBe(false);
  });
  it("treats null on both sides as agreement", () => {
    const c = compareQuantity({ value: null, unit: "unknown" }, { value: null, unit: "unknown" });
    expect(c.match).toBe(true);
  });
  it("treats null against a value as disagreement", () => {
    expect(compareQuantity({ value: null, unit: "unknown" }, inr(1)).match).toBe(false);
  });
  it("can accept an unlabelled unit when the caller opts in", () => {
    const c = compareQuantity(
      { value: 47, unit: "unknown" },
      { value: 47, unit: "count" },
      {
        allowUnknownUnit: true,
      },
    );
    expect(c.match).toBe(true);
  });
});

describe("extractNumericTokens", () => {
  it("pulls every quantity out of prose", () => {
    const qs = extractNumericTokens("ARR reached ₹8.1 crore, up 12% with 47 people.");
    expect(qs).toContainEqual({ value: 81_000_000, unit: "INR" });
    expect(qs).toContainEqual({ value: 12, unit: "pct" });
    expect(qs.some((q) => q.value === 47)).toBe(true);
  });
  it("returns nothing for text with no numbers", () => {
    expect(extractNumericTokens("no figures were disclosed")).toEqual([]);
  });
});
