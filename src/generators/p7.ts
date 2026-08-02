import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LayoutGuard,
  type TextOpts,
  addLightingGradient,
  addNoise,
  blur,
  box,
  drawText,
  drawTextRight,
  fitScale,
  hLine,
  rotate,
  textWidth,
} from "../render/draw.js";
import { GLYPH_H, unrenderable } from "../render/font.js";
import { type Bitmap, createBitmap, encodePng } from "../render/png.js";
import { Rng } from "./rng.js";

/**
 * P7 — vision extraction fixtures.
 *
 * Twelve invoices rendered from known field values, so grading compares against
 * what was planted rather than against a second model's reading. Layouts,
 * currencies and capture quality vary; some fields are deliberately absent, and
 * inventing a value for those is the failure mode the suite exists to catch.
 *
 * Every vendor is obviously fictional. Nothing here is safe to mistake for a
 * real company, and nothing here came from one.
 */

export interface LineItem {
  description: string;
  qty: number;
  unitMinor: number;
  amountMinor: number;
}

export interface InvoiceGold {
  id: string;
  vendor: string;
  invoiceNumber: string;
  date: string; // ISO
  currency: "INR" | "USD";
  subtotalMinor: number;
  /** Null when the invoice carries no tax line at all. */
  taxMinor: number | null;
  totalMinor: number;
  /** Null on invoices that print no tax id. */
  taxId: string | null;
  /** Null when no PO is referenced. */
  poNumber: string | null;
  lineItems: LineItem[];
  layout: "classic" | "receipt" | "minimal";
}

export const CAPTURES = ["scan", "photo", "poor"] as const;
export type Capture = (typeof CAPTURES)[number];

const VENDORS_INR = [
  "PORTHOLE LOGISTICS PVT LTD",
  "MISTFALL PAPER WORKS",
  "ORRERY INSTRUMENTS LLP",
  "PELLUCID COLD CHAIN PVT LTD",
  "KESTREL BINDERY",
  "TAMARIND SIGNAL WORKS",
];
const VENDORS_USD = [
  "GLASSWING SUPPLY CO",
  "NORTHWICK FABRICATION INC",
  "SALTMARSH TOOLING LLC",
  "DRIFTPIN HARDWARE CO",
  "BRAMBLEGATE OPTICS INC",
  "CINDERPATH MATERIALS LLC",
];

const GOODS = [
  "PALLET WRAP 500MM",
  "THERMAL LABELS 4X6",
  "CRATE LINER LARGE",
  "SENSOR MOUNT BRACKET",
  "COLD PACK GEL 2KG",
  "STEEL BANDING 19MM",
  "DESICCANT SACHET 50G",
  "CARTON 610X410X300",
  "STRAPPING SEAL 19MM",
  "LOGGER BATTERY CR2",
  "SHRINK FILM 450MM",
  "EDGE PROTECTOR 1M",
];

/** Two decimal places, grouped. Indian grouping for INR, thousands for USD. */
export function formatMinor(minor: number, currency: "INR" | "USD"): string {
  const neg = minor < 0;
  const whole = Math.floor(Math.abs(minor) / 100);
  const cents = String(Math.abs(minor) % 100).padStart(2, "0");
  let grouped: string;
  if (currency === "INR") {
    const s = String(whole);
    if (s.length <= 3) grouped = s;
    else {
      const last3 = s.slice(-3);
      const rest = s.slice(0, -3);
      grouped = `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
    }
  } else {
    grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  return `${neg ? "-" : ""}${grouped}.${cents}`;
}

function gstin(rng: Rng): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const pick = (s: string) => s[rng.int(0, s.length - 1)] as string;
  const digits = () => String(rng.int(0, 9));
  return (
    `${rng.int(10, 37)}` +
    `${pick(letters)}${pick(letters)}${pick(letters)}${pick(letters)}${pick(letters)}` +
    `${digits()}${digits()}${digits()}${digits()}` +
    `${pick(letters)}${digits()}Z${pick(letters)}`
  );
}

function ein(rng: Rng): string {
  return `${rng.int(10, 99)}-${String(rng.int(0, 9999999)).padStart(7, "0")}`;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function printedDate(iso: string, style: number): string {
  const [y, m, d] = iso.split("-") as [string, string, string];
  const mi = Number.parseInt(m, 10) - 1;
  if (style === 0) return `${d}/${m}/${y}`;
  if (style === 1) return `${d} ${MONTHS[mi]} ${y}`;
  return `${MONTHS[mi]} ${d}, ${y}`;
}

export function buildInvoices(seed: number): InvoiceGold[] {
  const rng = new Rng(seed);
  const out: InvoiceGold[] = [];
  const layouts: InvoiceGold["layout"][] = ["classic", "receipt", "minimal"];

  for (let i = 0; i < 12; i++) {
    const currency: "INR" | "USD" = i % 2 === 0 ? "INR" : "USD";
    const layout = layouts[i % 3] as InvoiceGold["layout"];
    const vendor = (currency === "INR" ? VENDORS_INR : VENDORS_USD)[
      Math.floor(i / 2) % 6
    ] as string;

    const nItems = rng.int(2, 5);
    const chosen = rng.sample(GOODS, nItems);
    const lineItems: LineItem[] = chosen.map((description) => {
      const qty = rng.int(1, 40);
      const unitMinor = rng.int(
        currency === "INR" ? 4500 : 250,
        currency === "INR" ? 250000 : 9500,
      );
      return { description, qty, unitMinor, amountMinor: qty * unitMinor };
    });
    const subtotalMinor = lineItems.reduce((n, l) => n + l.amountMinor, 0);

    // Every third invoice is zero-rated and prints no tax line at all. That is
    // the honest-null trap: the correct answer is null, not 0 and not a guess.
    const taxed = i % 3 !== 2;
    const rate = currency === "INR" ? 0.18 : 0.0825;
    const taxMinor = taxed ? Math.round(subtotalMinor * rate) : null;
    const totalMinor = subtotalMinor + (taxMinor ?? 0);

    out.push({
      id: `p7-${String(i + 1).padStart(3, "0")}`,
      vendor,
      invoiceNumber: `INV-2026-${String(1000 + i * 37).padStart(4, "0")}`,
      date: `2026-0${rng.int(1, 8)}-${String(rng.int(10, 28)).padStart(2, "0")}`,
      currency,
      subtotalMinor,
      taxMinor,
      totalMinor,
      // Half the invoices print no tax id.
      taxId: i % 2 === 0 ? (currency === "INR" ? gstin(rng) : ein(rng)) : null,
      poNumber: i % 4 === 1 ? `PO-${rng.int(40000, 99999)}` : null,
      lineItems,
      layout,
    });
  }
  return out;
}

// ─────────────────────────── rendering ───────────────────────────

/**
 * A page under construction: the bitmap plus the guard that notices when two
 * strings are about to occupy the same pixels.
 */
class Page {
  readonly guard = new LayoutGuard();
  constructor(readonly bm: Bitmap) {}

  private h(opts: TextOpts): number {
    return GLYPH_H * (opts.scale ?? 3);
  }

  left(x: number, y: number, text: string, opts: TextOpts = {}): void {
    this.guard.place(x, y, x + textWidth(text, opts), y + this.h(opts), text);
    drawText(this.bm, x, y, text, opts);
  }

  right(rightX: number, y: number, text: string, opts: TextOpts = {}): void {
    const w = textWidth(text, opts);
    this.guard.place(rightX - w, y, rightX, y + this.h(opts), text);
    drawTextRight(this.bm, rightX, y, text, opts);
  }

  centre(y: number, text: string, opts: TextOpts = {}): void {
    const w = textWidth(text, opts);
    this.left((this.bm.width - w) / 2, y, text, opts);
  }
}

function renderClassic(g: InvoiceGold): Page {
  const W = 1000;
  const height = 300 + g.lineItems.length * 44 + (g.taxMinor !== null ? 200 : 156) + 90;
  const p = new Page(createBitmap(W, height, 250));
  const sym = g.currency;

  // The vendor name shares its line with nothing, and shrinks if it is long.
  p.left(40, 40, g.vendor, { scale: fitScale(g.vendor, W - 80, 4), ink: 15 });
  p.left(40, 96, "TAX INVOICE", { scale: 3, ink: 60 });
  p.right(960, 96, `INVOICE ${g.invoiceNumber}`, { scale: 3 });
  p.left(40, 138, g.taxId ? `${g.currency === "INR" ? "GSTIN" : "EIN"}: ${g.taxId}` : "", {
    scale: 2,
  });
  p.right(960, 138, `DATE ${printedDate(g.date, 0)}`, { scale: 2 });
  if (g.poNumber) p.right(960, 168, `PO ${g.poNumber}`, { scale: 2 });

  hLine(p.bm, 40, 200, 920, 60, 2);

  let y = 226;
  p.left(48, y, "DESCRIPTION", { scale: 2, ink: 80 });
  p.right(600, y, "QTY", { scale: 2, ink: 80 });
  p.right(780, y, "UNIT", { scale: 2, ink: 80 });
  p.right(950, y, "AMOUNT", { scale: 2, ink: 80 });
  y += 30;
  hLine(p.bm, 40, y, 920, 140);
  y += 16;

  for (const li of g.lineItems) {
    p.left(48, y, li.description, { scale: 3 });
    p.right(600, y, String(li.qty), { scale: 3 });
    p.right(780, y, formatMinor(li.unitMinor, g.currency), { scale: 3 });
    p.right(950, y, formatMinor(li.amountMinor, g.currency), { scale: 3 });
    y += 44;
  }

  y += 16;
  hLine(p.bm, 520, y, 440, 140);
  y += 20;
  // Labels at scale 2 and values at scale 3, with 200px of clear air between
  // the label column and the right-aligned figures.
  p.left(530, y + 4, "SUBTOTAL", { scale: 2 });
  p.right(950, y, formatMinor(g.subtotalMinor, g.currency), { scale: 3 });
  y += 42;
  if (g.taxMinor !== null) {
    p.left(530, y + 4, g.currency === "INR" ? "GST 18%" : "SALES TAX 8.25%", { scale: 2 });
    p.right(950, y, formatMinor(g.taxMinor, g.currency), { scale: 3 });
    y += 42;
  } else {
    p.left(530, y + 4, "ZERO RATED - NO TAX", { scale: 2, ink: 110 });
    y += 42;
  }
  hLine(p.bm, 520, y, 440, 60, 2);
  y += 18;
  p.left(530, y + 8, "TOTAL", { scale: 3, ink: 15 });
  p.right(950, y, `${sym} ${formatMinor(g.totalMinor, g.currency)}`, { scale: 3, ink: 15 });

  p.left(40, height - 44, "SYNTHETIC TEST DATA", { scale: 2, ink: 175 });
  return p;
}

function renderReceipt(g: InvoiceGold): Page {
  const W = 600;
  const height = 260 + g.lineItems.length * 62 + (g.taxMinor !== null ? 190 : 152) + 70;
  const p = new Page(createBitmap(W, height, 252));
  const sym = g.currency;

  p.centre(36, g.vendor, { scale: fitScale(g.vendor, W - 40, 2), ink: 15 });
  p.centre(70, "SALES RECEIPT", { scale: 2, ink: 70 });
  p.centre(104, printedDate(g.date, 1), { scale: 2 });
  p.centre(138, g.invoiceNumber, { scale: 2 });
  if (g.taxId) {
    // scale 2, not 1: a 5x7 glyph survives a clean scan and dissolves under
    // the blur applied to the "poor" captures, which would make the tax id
    // untestable rather than merely hard.
    p.centre(172, `${g.currency === "INR" ? "GSTIN" : "EIN"} ${g.taxId}`, { scale: 2 });
  }

  let y = 216;
  hLine(p.bm, 30, y, W - 60, 150);
  y += 22;

  for (const li of g.lineItems) {
    p.left(30, y, li.description, { scale: 2 });
    y += 28;
    p.left(50, y, `${li.qty} X ${formatMinor(li.unitMinor, g.currency)}`, { scale: 2, ink: 70 });
    p.right(W - 30, y, formatMinor(li.amountMinor, g.currency), { scale: 2 });
    y += 34;
  }

  hLine(p.bm, 30, y, W - 60, 150);
  y += 22;
  p.left(30, y, "SUBTOTAL", { scale: 2 });
  p.right(W - 30, y, formatMinor(g.subtotalMinor, g.currency), { scale: 2 });
  y += 32;
  if (g.taxMinor !== null) {
    p.left(30, y, g.currency === "INR" ? "GST 18%" : "TAX 8.25%", { scale: 2 });
    p.right(W - 30, y, formatMinor(g.taxMinor, g.currency), { scale: 2 });
    y += 32;
  } else {
    p.left(30, y, "ZERO RATED", { scale: 2, ink: 110 });
    y += 32;
  }
  y += 10;
  p.left(30, y + 6, "TOTAL", { scale: 2, ink: 15 });
  p.right(W - 30, y, `${sym} ${formatMinor(g.totalMinor, g.currency)}`, { scale: 3, ink: 15 });
  y += 56;
  if (g.poNumber) p.centre(y, `PO ${g.poNumber}`, { scale: 2 });
  p.centre(height - 40, "SYNTHETIC TEST DATA", { scale: 1, ink: 170 });
  return p;
}

function renderMinimal(g: InvoiceGold): Page {
  const W = 940;
  const height = 300 + g.lineItems.length * 46 + (g.taxMinor !== null ? 190 : 150) + 80;
  const p = new Page(createBitmap(W, height, 248));
  const sym = g.currency;

  p.left(60, 70, g.vendor, { scale: fitScale(g.vendor, W - 120, 3), ink: 25 });
  p.left(60, 122, g.invoiceNumber, { scale: 2, ink: 80 });
  p.right(880, 122, printedDate(g.date, 2), { scale: 2, ink: 80 });
  if (g.taxId) p.left(60, 156, `TAX ID ${g.taxId}`, { scale: 2, ink: 110 });
  if (g.poNumber) p.right(880, 156, `REF ${g.poNumber}`, { scale: 2, ink: 110 });

  let y = 236;
  for (const li of g.lineItems) {
    p.left(60, y, `${li.qty} X ${li.description}`, { scale: 3 });
    p.right(880, y, formatMinor(li.amountMinor, g.currency), { scale: 3 });
    y += 46;
  }

  y += 34;
  box(p.bm, 470, y - 16, 410, g.taxMinor !== null ? 156 : 114, 130);
  p.left(492, y, "SUBTOTAL", { scale: 2 });
  p.right(860, y, formatMinor(g.subtotalMinor, g.currency), { scale: 2 });
  y += 36;
  if (g.taxMinor !== null) {
    p.left(492, y, g.currency === "INR" ? "GST" : "TAX", { scale: 2 });
    p.right(860, y, formatMinor(g.taxMinor, g.currency), { scale: 2 });
    y += 36;
  }
  p.left(492, y + 4, "DUE", { scale: 2, ink: 15 });
  p.right(860, y, `${sym} ${formatMinor(g.totalMinor, g.currency)}`, { scale: 3, ink: 15 });

  p.left(60, height - 44, "SYNTHETIC TEST DATA", { scale: 2, ink: 175 });
  return p;
}

/** Apply capture degradation. Deterministic: seeded by the invoice index. */
function degrade(bm: Bitmap, capture: Capture, index: number): Bitmap {
  if (capture === "scan") {
    addNoise(bm, 4, index + 1);
    return bm;
  }
  if (capture === "photo") {
    addLightingGradient(bm, 26, 0.6);
    addNoise(bm, 9, index + 1);
    return rotate(bm, index % 2 === 0 ? 1.0 : -1.2);
  }
  // "poor": the worst a phone snap on a desk realistically gets while still
  // being something a human would accept as readable.
  addLightingGradient(bm, 44, 2.2);
  addNoise(bm, 14, index + 1);
  blur(bm);
  // Kept under ~2 degrees on purpose. Across a 540px-wide receipt, 3 degrees
  // shears the right-hand column a full line-height below its own label, so
  // the fixture stops testing reading and starts testing shear tolerance.
  return rotate(bm, index % 2 === 0 ? -2.0 : 1.9);
}

export function renderInvoice(
  g: InvoiceGold,
  capture: Capture,
  index: number,
): { bm: Bitmap; collisions: string[] } {
  const page =
    g.layout === "classic"
      ? renderClassic(g)
      : g.layout === "receipt"
        ? renderReceipt(g)
        : renderMinimal(g);
  return { bm: degrade(page.bm, capture, index), collisions: page.guard.collisions };
}

/** Every string that reaches the page must be drawable, or the fixture lies. */
export function checkRenderable(g: InvoiceGold): string[] {
  const strings = [
    g.vendor,
    g.invoiceNumber,
    g.taxId ?? "",
    g.poNumber ?? "",
    ...g.lineItems.map((l) => l.description),
    formatMinor(g.totalMinor, g.currency),
  ];
  return unrenderable(strings.join(""));
}

export function generateP7(root: string, seed = 7): { count: number; dir: string } {
  const dir = join(root, "suites", "p7-vision", "fixtures");
  const goldDir = join(root, "suites", "p7-vision", "gold");
  mkdirSync(dir, { recursive: true });
  mkdirSync(goldDir, { recursive: true });

  const invoices = buildInvoices(seed);
  for (const [i, g] of invoices.entries()) {
    const bad = checkRenderable(g);
    if (bad.length > 0) {
      throw new Error(
        `${g.id}: font cannot draw ${JSON.stringify(bad)} — fix the font or the text`,
      );
    }
    // Arithmetic is asserted, not assumed: a gold total that does not add up
    // makes every model look wrong on that item.
    const sum = g.lineItems.reduce((n, l) => n + l.amountMinor, 0);
    if (sum !== g.subtotalMinor)
      throw new Error(`${g.id}: line items sum to ${sum}, subtotal says ${g.subtotalMinor}`);
    if (g.subtotalMinor + (g.taxMinor ?? 0) !== g.totalMinor) {
      throw new Error(`${g.id}: subtotal + tax does not equal total`);
    }
    for (const l of g.lineItems) {
      if (l.qty * l.unitMinor !== l.amountMinor) throw new Error(`${g.id}: line amount mismatch`);
    }
    // Every document is rendered at all three capture qualities. Assigning one
    // quality per document instead would confound capture with content: the
    // "scan vs poor" comparison would be four documents against four different
    // documents, and a model that happens to find one set harder would look
    // like a model that is robust to blur.
    for (const capture of CAPTURES) {
      const { bm, collisions } = renderInvoice(g, capture, i);
      if (collisions.length > 0) {
        throw new Error(`${g.id}: text collides on the page —\n  ${collisions.join("\n  ")}`);
      }
      writeFileSync(join(dir, `${g.id}-${capture}.png`), encodePng(bm));
    }
  }
  writeFileSync(join(goldDir, "invoices.json"), `${JSON.stringify(invoices, null, 2)}\n`);
  return { count: invoices.length * CAPTURES.length, dir };
}
