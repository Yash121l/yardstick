import { describe, expect, it } from "vitest";
import {
  CAPTURES,
  buildInvoices,
  checkRenderable,
  formatMinor,
  renderInvoice,
} from "../generators/p7.js";
import { fieldMatches } from "./p7.js";

describe("fieldMatches — absent means absent", () => {
  it("accepts null and undefined for an absent field", () => {
    expect(fieldMatches(null, null)).toBe(true);
    expect(fieldMatches(undefined, null)).toBe(true);
  });

  it("rejects the ways a model declines to say null", () => {
    // Each of these corrupts a downstream ledger differently, and none of them
    // is the model reporting what the document shows.
    for (const dodge of [0, "", "N/A", "n/a", "-", "none", "null", "0.00"]) {
      expect(fieldMatches(dodge, null), `${JSON.stringify(dodge)} is not null`).toBe(false);
    }
  });

  it("matches numbers within half a cent, in either type", () => {
    expect(fieldMatches(114787.52, 114787.52)).toBe(true);
    expect(fieldMatches("114787.52", 114787.52)).toBe(true);
    expect(fieldMatches("INR 1,14,787.52", 114787.52)).toBe(true);
    expect(fieldMatches(114787.53, 114787.52)).toBe(false);
  });

  it("does not let a transposed figure through", () => {
    expect(fieldMatches(114878.52, 114787.52)).toBe(false);
  });

  it("ignores case and punctuation in printed strings but not the letters", () => {
    expect(fieldMatches("porthole logistics pvt. ltd.", "PORTHOLE LOGISTICS PVT LTD")).toBe(true);
    expect(fieldMatches("PORTHOLE LOGISTIC PVT LTD", "PORTHOLE LOGISTICS PVT LTD")).toBe(false);
  });
});

describe("formatMinor — grouping differs by currency", () => {
  it("uses Indian grouping for INR", () => {
    expect(formatMinor(11478752, "INR")).toBe("1,14,787.52");
    expect(formatMinor(4843480, "INR")).toBe("48,434.80");
  });

  it("uses thousands grouping for USD", () => {
    expect(formatMinor(11478752, "USD")).toBe("114,787.52");
  });

  it("keeps both decimal places", () => {
    expect(formatMinor(100, "USD")).toBe("1.00");
    expect(formatMinor(105, "USD")).toBe("1.05");
  });
});

describe("P7 fixtures", { timeout: 60_000 }, () => {
  const invoices = buildInvoices(20260807);

  it("renders 12 invoices across every layout and currency", () => {
    expect(invoices).toHaveLength(12);
    expect(new Set(invoices.map((i) => i.layout)).size).toBe(3);
    expect(new Set(invoices.map((i) => i.currency))).toEqual(new Set(["INR", "USD"]));
  });

  it("renders every document at every capture quality, not one each", () => {
    // Assigning one quality per document confounds capture with content: the
    // degradation curve would compare four documents against four others.
    for (const [i, g] of invoices.entries()) {
      for (const capture of CAPTURES) {
        expect(renderInvoice(g, capture, i).collisions, `${g.id}/${capture}`).toEqual([]);
      }
    }
  });

  it("actually degrades the image as capture quality drops", () => {
    const g = invoices[0]!;
    const scan = renderInvoice(g, "scan", 0).bm;
    const poor = renderInvoice(g, "poor", 0).bm;
    expect(Buffer.from(scan.data).equals(Buffer.from(poor.data))).toBe(false);
  });

  it("plants absent fields to test honest-null, not just reading", () => {
    expect(invoices.filter((i) => i.taxMinor === null).length).toBeGreaterThan(0);
    expect(invoices.filter((i) => i.taxId === null).length).toBeGreaterThan(0);
    expect(invoices.filter((i) => i.poNumber === null).length).toBeGreaterThan(0);
  });

  it("has arithmetic that adds up", () => {
    for (const g of invoices) {
      const sum = g.lineItems.reduce((n, l) => n + l.amountMinor, 0);
      expect(sum, g.id).toBe(g.subtotalMinor);
      expect(g.subtotalMinor + (g.taxMinor ?? 0), g.id).toBe(g.totalMinor);
    }
  });

  it("draws every character it needs", () => {
    for (const g of invoices) expect(checkRenderable(g), g.id).toEqual([]);
  });

  it("never draws text on top of other text", () => {
    // The failure this catches produced "SUBTOTAINR" on the first render.
    for (const [i, g] of invoices.entries()) {
      expect(renderInvoice(g, "scan", i).collisions, g.id).toEqual([]);
    }
  });

  it("renders deterministically", () => {
    const a = renderInvoice(invoices[0]!, "poor", 0).bm;
    const b = renderInvoice(invoices[0]!, "poor", 0).bm;
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
  });
});
