/**
 * Quantity normalisation.
 *
 * Everything is reduced to a canonical (value, unit) pair before comparison, so
 * "₹8.1 crore" and "81000000 INR" are the same fact, while "12%" and "12 pp"
 * stay different facts — conflating those two is a real reporting error, not a
 * formatting difference.
 */

export type CanonicalUnit = "INR" | "USD" | "pct" | "pp" | "months" | "count" | "ratio" | "unknown";

export interface Quantity {
  value: number | null;
  unit: CanonicalUnit;
}

const CRORE = 10_000_000;
const LAKH = 100_000;
const MILLION = 1_000_000;
const BILLION = 1_000_000_000;
const THOUSAND = 1_000;

/** Indian and Western number words the fixtures spell out. */
const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
};

/** "twenty-five" -> 25, "twelve" -> 12. Returns null when it is not a number word. */
export function parseNumberWords(text: string): number | null {
  const cleaned = text
    .trim()
    .toLowerCase()
    .replace(/\band\b/g, " ");
  const parts = cleaned.split(/[\s-]+/).filter(Boolean);
  if (parts.length === 0) return null;

  let total = 0;
  let current = 0;
  let matched = false;
  for (const part of parts) {
    const v = NUMBER_WORDS[part];
    if (v === undefined) return null;
    matched = true;
    if (v === 100) {
      current = (current === 0 ? 1 : current) * 100;
    } else {
      current += v;
    }
  }
  total += current;
  return matched ? total : null;
}

/** Strip grouping separators without destroying the decimal point. */
function toNumber(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").trim();
  if (cleaned === "") return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a quantity out of free text: "₹8.1 crore", "$9 million", "about twelve
 * crore", "14 months", "2.1%", "3 pp", "47".
 *
 * Returns unit "unknown" when the magnitude is readable but the unit is not, so
 * callers can decide whether that is a miss or merely an unlabelled count.
 */
export function parseQuantity(input: string): Quantity {
  const text = input.trim().toLowerCase().replace(/ /g, " ");
  if (text === "") return { value: null, unit: "unknown" };

  const hasRupee = /₹|\brs\.?\b|\binr\b/.test(text);
  const hasDollar = /\$|\busd\b|\bdollars?\b/.test(text);

  // Numeric magnitude, or a spelled-out one.
  const numMatch = /(-?[\d,]+(?:\.\d+)?)/.exec(text);
  let magnitude: number | null = numMatch?.[1] ? toNumber(numMatch[1]) : null;
  if (magnitude === null) {
    const words =
      /(?:about|around|roughly|nearly|approximately)?\s*([a-z-\s]+?)\s*(?:crore|lakh|million|billion|thousand|per cent|percent|months?|people|employees|staff|heads?)\b/.exec(
        text,
      );
    if (words?.[1]) magnitude = parseNumberWords(words[1]);
    if (magnitude === null) magnitude = parseNumberWords(text);
  }
  if (magnitude === null) return { value: null, unit: "unknown" };

  // Scale words. Indian scales imply INR unless a dollar sign says otherwise.
  let scale = 1;
  let impliedCurrency: CanonicalUnit | null = null;
  if (/\bcrores?\b/.test(text)) {
    scale = CRORE;
    impliedCurrency = "INR";
  } else if (/\blakhs?\b/.test(text)) {
    scale = LAKH;
    impliedCurrency = "INR";
    // A digit followed directly by a suffix has no word boundary between them,
    // so "$250k" needs an explicit lookbehind — \bk\b never fires there.
  } else if (/(?<=\d)\s?bn\b|\bbillions?\b/.test(text)) {
    scale = BILLION;
  } else if (/(?<=\d)\s?mn\b|\bmillions?\b|(?<=\d)\s?m\b/.test(text)) {
    scale = MILLION;
  } else if (/(?<=\d)\s?k\b|\bthousands?\b/.test(text)) {
    scale = THOUSAND;
  }

  // Percentage points are a DIFFERENT unit from percent. This distinction is
  // the whole reason the pp trap exists.
  if (/\bpercentage points?\b|\bpp\b|\bppt\b/.test(text)) {
    return { value: magnitude, unit: "pp" };
  }
  if (/%|\bpercent\b|\bper cent\b/.test(text)) {
    return { value: magnitude, unit: "pct" };
  }

  // Currency is decided BEFORE duration. A burn rate reads "₹59 lakh per
  // month": that is money with a rate qualifier, and checking for "month"
  // first would silently turn it into 59 months.
  if (hasDollar) return { value: magnitude * scale, unit: "USD" };
  if (hasRupee || impliedCurrency === "INR") return { value: magnitude * scale, unit: "INR" };

  if (/\bmonths?\b|\bmos\b/.test(text)) return { value: magnitude, unit: "months" };
  if (/\byears?\b/.test(text)) return { value: magnitude * 12, unit: "months" };
  if (/\bpeople\b|\bemployees\b|\bstaff\b|\bheads?\b|\bheadcount\b|\bftes?\b/.test(text)) {
    return { value: magnitude, unit: "count" };
  }
  if (/\bx\b/.test(text)) return { value: magnitude, unit: "ratio" };

  if (scale !== 1) return { value: magnitude * scale, unit: "unknown" };
  return { value: magnitude, unit: "unknown" };
}

/**
 * Normalise a model-supplied (value, unit) pair.
 *
 * The unit string usually carries the scale ("INR crore"), so the two are
 * parsed together rather than independently.
 */
export function normalizeQuantity(value: unknown, unit: unknown): Quantity {
  const unitText = typeof unit === "string" ? unit : "";

  if (typeof value === "number") {
    const combined = parseQuantity(`${value} ${unitText}`.trim());
    if (combined.unit !== "unknown") return combined;
    return { value, unit: "unknown" };
  }
  if (typeof value === "string") {
    const fromValue = parseQuantity(`${value} ${unitText}`.trim());
    if (fromValue.value !== null) return fromValue;
  }
  return { value: null, unit: "unknown" };
}

export interface CompareOptions {
  /** Relative tolerance for the magnitude. Default 0.5%. */
  relTolerance?: number;
  /** Treat an "unknown" unit on one side as compatible with the other. */
  allowUnknownUnit?: boolean;
}

export interface Comparison {
  valueMatches: boolean;
  unitMatches: boolean;
  match: boolean;
}

/** Value AND unit must both agree for a fact to count as extracted correctly. */
export function compareQuantity(
  got: Quantity,
  want: Quantity,
  opts: CompareOptions = {},
): Comparison {
  const rel = opts.relTolerance ?? 0.005;

  if (got.value === null || want.value === null) {
    const both = got.value === null && want.value === null;
    return { valueMatches: both, unitMatches: both, match: both };
  }

  const scale = Math.max(Math.abs(want.value), 1);
  const valueMatches = Math.abs(got.value - want.value) <= rel * scale;

  const unitMatches =
    got.unit === want.unit ||
    (opts.allowUnknownUnit === true && (got.unit === "unknown" || want.unit === "unknown"));

  return { valueMatches, unitMatches, match: valueMatches && unitMatches };
}

/**
 * Every numeric token in a piece of text, canonicalised.
 * Used by P4's number-traceability check; lives here so both share one parser.
 */
export function extractNumericTokens(text: string): Quantity[] {
  const out: Quantity[] = [];
  const re =
    /(?:₹|\$)?\s?-?[\d,]+(?:\.\d+)?\s*(?:crores?|lakhs?|millions?|billions?|thousands?|mn|bn|k|m|%|percentage points?|pp|percent|per cent|months?|years?|people|employees|staff|x)?/gi;
  for (const m of text.matchAll(re)) {
    const raw = m[0].trim();
    if (!/\d/.test(raw)) continue;
    const q = parseQuantity(raw);
    if (q.value !== null) out.push(q);
  }
  return out;
}
