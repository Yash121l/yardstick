import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Invoice, price } from "../src/pricing.js";

const SRC = readFileSync(join(import.meta.dirname, "..", "src", "pricing.ts"), "utf8");

/**
 * Behaviour is pinned separately by the characterization hash. These assert the
 * refactor actually happened: leaving the file untouched preserves behaviour
 * perfectly and is not the task.
 */
describe("structure", () => {
  it("computes the tier discount in one place, not two", () => {
    // The original repeats the discount ladder in the net loop and again in the
    // tax loop. 0.85 is the partner-under-bulk rate and appeared twice.
    expect(SRC.split("0.85").length - 1).toBeLessThanOrEqual(1);
  });

  it("computes the volume rebate in one place", () => {
    expect(SRC.split("0.02").length - 1).toBeLessThanOrEqual(1);
  });

  it("no longer has a single function doing the whole calculation", () => {
    const priceBody = SRC.slice(SRC.indexOf("export function price("));
    expect(priceBody.split("\n").length).toBeLessThan(30);
  });

  it("names the magic numbers", () => {
    expect(SRC).toMatch(/const\s+[A-Z_]{3,}\s*[:=]/);
  });
});

describe("behaviour", () => {
  const cases: Array<[Invoice, number, number]> = [
    [{ lines: [{ sku: "a", qty: 1, unitPence: 1000, category: "standard" }], customerTier: "retail", countryCode: "GB" }, 1000, 200],
    [{ lines: [{ sku: "a", qty: 9, unitPence: 111, category: "reduced" }], customerTier: "partner", countryCode: "IE" }, 849, 115],
    [{ lines: [{ sku: "a", qty: 10, unitPence: 111, category: "reduced" }], customerTier: "partner", countryCode: "IE" }, 888, 120],
    [{ lines: [{ sku: "a", qty: 100, unitPence: 7, category: "standard" }], customerTier: "retail", countryCode: "GB" }, 686, 137],
  ];
  for (const [inv, net, tax] of cases) {
    it(`preserves ${inv.customerTier}/${inv.countryCode}/qty${inv.lines[0]!.qty}`, () => {
      const r = price(inv);
      expect(r.netPence).toBe(net);
      expect(r.taxPence).toBe(tax);
    });
  }

  it("keeps charging tax on a fully couponed invoice, as the original did", () => {
    const r = price({
      lines: [{ sku: "a", qty: 1, unitPence: 100, category: "standard" }],
      customerTier: "retail",
      countryCode: "GB",
      couponPence: 100000,
    });
    expect(r.netPence).toBe(0);
    expect(r.taxPence).toBe(20);
  });
});
