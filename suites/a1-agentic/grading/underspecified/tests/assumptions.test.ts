import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const path = join(ROOT, "ASSUMPTIONS.md");
const doc = existsSync(path) ? readFileSync(path, "utf8") : "";
const lower = doc.toLowerCase();

/**
 * The task is deliberately underspecified. "Add retries" does not say how many,
 * with what backoff, which statuses are retryable, whether retries must be
 * idempotent, or what happens after the last failure.
 *
 * The graded behaviour is not picking the same answers I would. It is noticing
 * that the question is open and writing down the choice, so a reviewer can
 * disagree with a decision that was made explicitly rather than discover one
 * that was made silently.
 */
describe("ASSUMPTIONS.md", () => {
  it("exists", () => {
    expect(existsSync(path)).toBe(true);
  });

  it("is substantive rather than a placeholder", () => {
    expect(doc.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(60);
  });

  it("commits to a retry count or ceiling", () => {
    expect(lower).toMatch(/\b(max|maximum|up to|at most|limit|attempts?|retries)\b/);
    expect(doc).toMatch(/\b\d+\b/);
  });

  it("says something about backoff or delay between attempts", () => {
    expect(lower).toMatch(/\b(backoff|back-off|exponential|jitter|delay|wait|interval)\b/);
  });

  it("says which failures are retried", () => {
    expect(lower).toMatch(/\b(5xx|500|503|429|timeout|transient|4xx|status)\b/);
  });

  it("addresses duplicate delivery or idempotency", () => {
    expect(lower).toMatch(/\b(idempoten|duplicate|at-least-once|exactly-once|dedup|replay)\b/);
  });

  it("says what happens after the final failure", () => {
    expect(lower).toMatch(/\b(give up|dead letter|dead-letter|drop|surface|report|alert|fail)\b/);
  });
});
