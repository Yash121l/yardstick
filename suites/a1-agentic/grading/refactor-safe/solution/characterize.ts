// Characterization harness. Do not modify.
import { type Invoice, price } from "./src/pricing.ts";

const CASES: Invoice[] = [
  { lines: [{ sku: "a", qty: 1, unitPence: 1000, category: "standard" }], customerTier: "retail", countryCode: "GB" },
  { lines: [{ sku: "a", qty: 3, unitPence: 333, category: "standard" }], customerTier: "trade", countryCode: "GB" },
  { lines: [{ sku: "a", qty: 9, unitPence: 111, category: "reduced" }], customerTier: "partner", countryCode: "IE" },
  { lines: [{ sku: "a", qty: 10, unitPence: 111, category: "reduced" }], customerTier: "partner", countryCode: "IE" },
  { lines: [{ sku: "a", qty: 100, unitPence: 7, category: "standard" }], customerTier: "retail", countryCode: "GB" },
  { lines: [{ sku: "a", qty: 101, unitPence: 7, category: "zero" }], customerTier: "trade", countryCode: "IE" },
  {
    lines: [
      { sku: "a", qty: 2, unitPence: 1999, category: "standard" },
      { sku: "b", qty: 5, unitPence: 349, category: "reduced" },
      { sku: "c", qty: 1, unitPence: 100, category: "zero" },
    ],
    customerTier: "partner",
    countryCode: "GB",
    couponPence: 500,
  },
  { lines: [{ sku: "a", qty: 1, unitPence: 100, category: "standard" }], customerTier: "retail", countryCode: "GB", couponPence: 100000 },
  { lines: [{ sku: "a", qty: 7, unitPence: 143, category: "standard" }], customerTier: "partner", countryCode: "FR" },
];

for (const c of CASES) {
  const r = price(c);
  console.log(`${r.netPence} ${r.taxPence} ${r.totalPence}`);
}
