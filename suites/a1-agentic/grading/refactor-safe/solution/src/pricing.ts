export interface Line {
  sku: string;
  qty: number;
  unitPence: number;
  category: "standard" | "reduced" | "zero";
}

export interface Invoice {
  lines: Line[];
  customerTier: "retail" | "trade" | "partner";
  countryCode: string;
  couponPence?: number;
}

const TIER_DISCOUNT = {
  retail: () => 1,
  trade: () => 0.9,
  partner: (qty: number) => (qty >= BULK_QTY ? 0.8 : 0.85),
} as const;

const BULK_QTY = 10;
const VOLUME_QTY = 100;
const VOLUME_REBATE = 0.02;

const VAT: Record<string, Record<Line["category"], number>> = {
  GB: { standard: 0.2, reduced: 0.05, zero: 0 },
  IE: { standard: 0.23, reduced: 0.135, zero: 0 },
};

/** Discounted line subtotal, before coupon and before tax. */
function lineSubtotal(line: Line, tier: Invoice["customerTier"]): number {
  const gross = line.qty * line.unitPence;
  const discounted = Math.round(gross * TIER_DISCOUNT[tier](line.qty));
  return line.qty >= VOLUME_QTY
    ? discounted - Math.round(discounted * VOLUME_REBATE)
    : discounted;
}

function lineTax(line: Line, subtotal: number, countryCode: string): number {
  const rate = VAT[countryCode]?.[line.category] ?? 0;
  return Math.round(subtotal * rate);
}

/**
 * Behaviour preserved deliberately: tax is charged on the pre-coupon subtotal,
 * so an invoice fully covered by a coupon still carries tax. That is what the
 * original did, and the characterization output pins it.
 */
export function price(inv: Invoice): { netPence: number; taxPence: number; totalPence: number } {
  const subtotals = inv.lines.map((l) => lineSubtotal(l, inv.customerTier));

  const gross = subtotals.reduce((n, s) => n + s, 0);
  const netPence = Math.max(0, gross - (inv.couponPence ?? 0));

  const taxPence = inv.lines.reduce(
    (n, l, i) => n + lineTax(l, subtotals[i] as number, inv.countryCode),
    0,
  );

  return { netPence, taxPence, totalPence: netPence + taxPence };
}
