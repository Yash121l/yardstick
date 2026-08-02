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

export function price(inv: Invoice): { netPence: number; taxPence: number; totalPence: number } {
  let net = 0;
  for (const l of inv.lines) {
    let sub = l.qty * l.unitPence;
    if (inv.customerTier === "trade") {
      sub = Math.round(sub * 0.9);
    } else if (inv.customerTier === "partner") {
      if (l.qty >= 10) {
        sub = Math.round(sub * 0.8);
      } else {
        sub = Math.round(sub * 0.85);
      }
    }
    if (l.qty >= 100) {
      sub = sub - Math.round(sub * 0.02);
    }
    net = net + sub;
  }
  if (inv.couponPence !== undefined && inv.couponPence > 0) {
    net = net - inv.couponPence;
    if (net < 0) {
      net = 0;
    }
  }
  let tax = 0;
  for (const l of inv.lines) {
    let sub = l.qty * l.unitPence;
    if (inv.customerTier === "trade") {
      sub = Math.round(sub * 0.9);
    } else if (inv.customerTier === "partner") {
      if (l.qty >= 10) {
        sub = Math.round(sub * 0.8);
      } else {
        sub = Math.round(sub * 0.85);
      }
    }
    if (l.qty >= 100) {
      sub = sub - Math.round(sub * 0.02);
    }
    if (l.category === "standard") {
      if (inv.countryCode === "GB") {
        tax = tax + Math.round(sub * 0.2);
      } else if (inv.countryCode === "IE") {
        tax = tax + Math.round(sub * 0.23);
      } else {
        tax = tax + 0;
      }
    } else if (l.category === "reduced") {
      if (inv.countryCode === "GB") {
        tax = tax + Math.round(sub * 0.05);
      } else if (inv.countryCode === "IE") {
        tax = tax + Math.round(sub * 0.135);
      } else {
        tax = tax + 0;
      }
    }
  }
  return { netPence: net, taxPence: tax, totalPence: net + tax };
}
