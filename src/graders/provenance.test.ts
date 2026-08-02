import { describe, expect, it } from "vitest";
import { checkProvenance, normalizeWhitespace, occurrences } from "./provenance.js";

/**
 * Adversarial tests for the provenance grader.
 *
 * This grader decides whether a citation is real. If it can be fooled, every
 * P1 number is worthless — so these tests attack it rather than confirm it.
 */

const SOURCE = [
  "DEV CASTELLAN: So on the topline, we closed the quarter at an ARR of ₹8.1 crore, up from ₹5.2 crore.",
  "ANAYA VERMILLION: And that's separate from the ₹8.4 crore Series A we banked in March.",
  "DEV CASTELLAN: Right. Team's at about forty-seven people now.",
  "ANAYA VERMILLION: On cash, we said nine months of runway last board, but after the bridge we're at fourteen months.",
].join("\n\n");

const ARR_QUOTE = "we closed the quarter at an ARR of ₹8.1 crore";

describe("normalizeWhitespace", () => {
  it("collapses runs of spaces", () => {
    expect(normalizeWhitespace("a    b")).toBe("a b");
  });
  it("collapses newlines and tabs", () => {
    expect(normalizeWhitespace("a\n\n\tb")).toBe("a b");
  });
  it("collapses non-breaking spaces", () => {
    expect(normalizeWhitespace("a  b")).toBe("a b");
  });
  it("collapses narrow and zero-width spaces", () => {
    expect(normalizeWhitespace("a ​b")).toBe("a b");
  });
  it("trims the ends", () => {
    expect(normalizeWhitespace("  a b  ")).toBe("a b");
  });
  it("leaves punctuation alone", () => {
    expect(normalizeWhitespace("it's  “quoted”")).toBe("it's “quoted”");
  });
});

describe("checkProvenance — accepts genuine citations", () => {
  it("accepts an exact quote", () => {
    const r = checkProvenance({ quote: ARR_QUOTE, source: SOURCE });
    expect(r.ok).toBe(true);
    expect(r.failure).toBeNull();
  });

  it("accepts a quote whose internal whitespace differs", () => {
    const r = checkProvenance({
      quote: "we closed   the quarter\n at an ARR of ₹8.1 crore",
      source: SOURCE,
    });
    expect(r.ok).toBe(true);
  });

  it("accepts a quote padded with leading and trailing whitespace", () => {
    const r = checkProvenance({ quote: `\n\t  ${ARR_QUOTE}  \n`, source: SOURCE });
    expect(r.ok).toBe(true);
  });

  it("accepts a quote containing a non-breaking space where the source has a normal one", () => {
    const r = checkProvenance({
      quote: ARR_QUOTE.replace(/ /g, " "),
      source: SOURCE,
    });
    expect(r.ok).toBe(true);
  });

  it("accepts a quote that spans the source's own line break", () => {
    const r = checkProvenance({
      quote: "up from ₹5.2 crore. ANAYA VERMILLION: And that's separate",
      source: SOURCE,
    });
    expect(r.ok).toBe(true);
  });
});

describe("checkProvenance — rejects fabrication", () => {
  it("rejects a wholly invented quote", () => {
    const r = checkProvenance({ quote: "net churn held at 2.1% this quarter", source: SOURCE });
    expect(r.ok).toBe(false);
    expect(r.failure).toBe("not-verbatim");
  });

  it("rejects a quote that is plausible but never said", () => {
    // Every word appears in the source; the sentence does not.
    const r = checkProvenance({
      quote: "we closed the quarter at fourteen months",
      source: SOURCE,
    });
    expect(r.ok).toBe(false);
    expect(r.failure).toBe("not-verbatim");
  });

  it("rejects an empty quote", () => {
    expect(checkProvenance({ quote: "", source: SOURCE }).failure).toBe("empty");
    expect(checkProvenance({ quote: "   ", source: SOURCE }).failure).toBe("empty");
  });

  it("rejects a null or non-string quote", () => {
    expect(checkProvenance({ quote: null, source: SOURCE }).failure).toBe("empty");
    expect(checkProvenance({ quote: 8.1, source: SOURCE }).failure).toBe("empty");
  });

  it("rejects a quote too short to evidence anything", () => {
    // "₹8.1 crore" appears verbatim, but a fragment that short cites nothing.
    const r = checkProvenance({ quote: "₹8.1", source: SOURCE });
    expect(r.ok).toBe(false);
    expect(r.nearMiss).toBe("truncation");
  });

  it("rejects a quote that only matches after punctuation is normalised, and says so", () => {
    const r = checkProvenance({
      quote: "we closed the quarter at an ARR of ₹8.1 crore,",
      source: "DEV: we closed the quarter at an ARR of ₹8.1 crore up from ₹5.2 crore.",
    });
    expect(r.ok).toBe(false);
    expect(r.nearMiss).toBe("punctuation");
    expect(r.detail).toContain("punctuation");
  });

  it("rejects a case-altered quote and labels the near miss", () => {
    const r = checkProvenance({ quote: ARR_QUOTE.toUpperCase(), source: SOURCE });
    expect(r.ok).toBe(false);
    expect(r.nearMiss).toBe("case");
  });
});

describe("checkProvenance — rejects verbatim quotes from the wrong place", () => {
  it("rejects a real quote lifted from a different section", () => {
    // Verbatim, but it evidences the runway line, not the ARR fact.
    const r = checkProvenance({
      quote: "after the bridge we're at fourteen months",
      source: SOURCE,
      plantedQuote: ARR_QUOTE,
    });
    expect(r.ok).toBe(false);
    expect(r.failure).toBe("wrong-section");
    expect(r.detail).toContain("does not support the value");
  });

  it("rejects a real quote from a different speaker's line", () => {
    const r = checkProvenance({
      quote: "that's separate from the ₹8.4 crore Series A we banked in March",
      source: SOURCE,
      plantedQuote: ARR_QUOTE,
    });
    expect(r.ok).toBe(false);
    expect(r.failure).toBe("wrong-section");
  });

  it("accepts a quote that overlaps the planted span from the left", () => {
    const r = checkProvenance({
      quote: "So on the topline, we closed the quarter at an ARR of ₹8.1 crore",
      source: SOURCE,
      plantedQuote: ARR_QUOTE,
    });
    expect(r.ok).toBe(true);
  });

  it("accepts a quote strictly inside the planted span", () => {
    const r = checkProvenance({
      quote: "an ARR of ₹8.1 crore",
      source: SOURCE,
      plantedQuote: ARR_QUOTE,
    });
    expect(r.ok).toBe(true);
  });

  it("accepts a quote that extends past the planted span on the right", () => {
    const r = checkProvenance({
      quote: `${ARR_QUOTE}, up from ₹5.2 crore`,
      source: SOURCE,
      plantedQuote: ARR_QUOTE,
    });
    expect(r.ok).toBe(true);
  });

  it("blames the fixture, not the model, when the planted quote is missing", () => {
    const r = checkProvenance({
      quote: ARR_QUOTE,
      source: SOURCE,
      plantedQuote: "a sentence the generator never actually inserted",
    });
    expect(r.failure).toBe("ambiguous-source");
    expect(r.detail).toContain("fixture defect");
  });

  it("does not apply the span check when no planted quote is supplied", () => {
    const r = checkProvenance({
      quote: "after the bridge we're at fourteen months",
      source: SOURCE,
    });
    expect(r.ok).toBe(true);
  });
});

describe("occurrences", () => {
  it("counts a repeated phrase", () => {
    expect(occurrences("a b a b a", "a b")).toBe(2);
  });
  it("is whitespace-insensitive", () => {
    expect(occurrences("a   b", "a b")).toBe(1);
  });
  it("returns 0 for an absent phrase", () => {
    expect(occurrences(SOURCE, "net churn")).toBe(0);
  });
  it("returns 0 for an empty needle rather than infinity", () => {
    expect(occurrences(SOURCE, "")).toBe(0);
  });
});
