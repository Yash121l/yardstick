/**
 * Provenance checking.
 *
 * The production rule this encodes: a correct value with a fabricated quote is
 * a FAILURE, not a partial credit. An extraction pipeline whose citations
 * cannot be trusted is worse than one that abstains, because the citation is
 * what makes the number checkable.
 *
 * Two independent checks:
 *   1. verbatim  — the quote is a whitespace-normalized substring of the source
 *   2. onTarget  — that substring overlaps the span the fact was planted in
 *
 * Check 2 exists because a model can satisfy check 1 by quoting any sentence in
 * an 8,000-token transcript. A quote from the wrong section is still fabricated
 * evidence even though every character of it appears in the document.
 */

export type ProvenanceFailure = "empty" | "not-verbatim" | "wrong-section" | "ambiguous-source";

export interface ProvenanceResult {
  ok: boolean;
  failure: ProvenanceFailure | null;
  /** Why it nearly matched — reported as evidence, never used to soften the score. */
  nearMiss: "punctuation" | "case" | "truncation" | null;
  /** Character span of the model's quote inside the normalized source, if found. */
  span: { start: number; end: number } | null;
  detail: string;
}

/**
 * Collapse every run of whitespace to a single space and trim.
 *
 * Non-breaking spaces, tabs and newlines are whitespace and are normalized.
 * Nothing else is: a changed apostrophe or dropped comma is a different string,
 * and treating it as equal would quietly weaken "verbatim" to "roughly".
 */
export function normalizeWhitespace(s: string): string {
  return s.replace(/[\s   ​]+/g, " ").trim();
}

/** Looser form used ONLY to explain a near miss in the evidence. */
function loosen(s: string): string {
  return normalizeWhitespace(s)
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/[.,;:!?]/g, "");
}

export interface ProvenanceCheckInput {
  /** The quote the model returned. */
  quote: unknown;
  /** The full source document. */
  source: string;
  /**
   * The quote the generator planted for this fact. When present, the model's
   * quote must overlap it — this is what catches a verbatim quote lifted from
   * an unrelated part of the document.
   */
  plantedQuote?: string | null;
  /** Minimum quote length; guards against a one-word "quote" matching anywhere. */
  minChars?: number;
}

export function checkProvenance(input: ProvenanceCheckInput): ProvenanceResult {
  const minChars = input.minChars ?? 12;

  if (typeof input.quote !== "string" || input.quote.trim() === "") {
    return {
      ok: false,
      failure: "empty",
      nearMiss: null,
      span: null,
      detail: "no quote supplied",
    };
  }

  const source = normalizeWhitespace(input.source);
  const quote = normalizeWhitespace(input.quote);

  if (quote.length < minChars) {
    return {
      ok: false,
      failure: "not-verbatim",
      nearMiss: "truncation",
      span: null,
      detail: `quote is ${quote.length} chars, below the ${minChars}-char minimum — too short to evidence anything`,
    };
  }

  const start = source.indexOf(quote);
  if (start === -1) {
    // Work out WHY it missed, for the drill-down. This never changes the verdict.
    const looseSource = loosen(source);
    const looseQuote = loosen(quote);
    let nearMiss: ProvenanceResult["nearMiss"] = null;
    if (looseSource.includes(looseQuote)) {
      nearMiss = normalizeWhitespace(input.source).toLowerCase().includes(quote.toLowerCase())
        ? "case"
        : "punctuation";
    }
    return {
      ok: false,
      failure: "not-verbatim",
      nearMiss,
      span: null,
      detail:
        nearMiss === null
          ? `quote does not appear in the source: ${JSON.stringify(quote.slice(0, 120))}`
          : `quote matches only after ${nearMiss} normalisation, which the verbatim rule does not allow: ${JSON.stringify(quote.slice(0, 120))}`,
    };
  }

  const span = { start, end: start + quote.length };

  if (input.plantedQuote) {
    const planted = normalizeWhitespace(input.plantedQuote);
    const plantedStart = source.indexOf(planted);
    if (plantedStart === -1) {
      // The fixture itself is broken; say so rather than blaming the model.
      return {
        ok: false,
        failure: "ambiguous-source",
        nearMiss: null,
        span,
        detail: "planted quote is not present in the source — fixture defect, not a model error",
      };
    }
    const plantedEnd = plantedStart + planted.length;
    const overlaps = span.start < plantedEnd && plantedStart < span.end;
    if (!overlaps) {
      return {
        ok: false,
        failure: "wrong-section",
        nearMiss: null,
        span,
        detail:
          `quote is verbatim but comes from chars ${span.start}-${span.end}, ` +
          `while the fact is stated at ${plantedStart}-${plantedEnd} — the citation does not support the value`,
      };
    }
  }

  return { ok: true, failure: null, nearMiss: null, span, detail: "verbatim and on target" };
}

/** True when the source states the same text more than once. */
export function occurrences(source: string, needle: string): number {
  const s = normalizeWhitespace(source);
  const n = normalizeWhitespace(needle);
  if (n === "") return 0;
  let count = 0;
  let i = s.indexOf(n);
  while (i !== -1) {
    count++;
    i = s.indexOf(n, i + 1);
  }
  return count;
}
