import { describe, expect, it } from "vitest";
import { assertsCause, gradeFindings } from "./checks.js";
import type { PlantedDefect } from "./types.js";

describe("assertsCause — mentioning a cause is not diagnosing it", () => {
  it("flags a term asserted as the cause", () => {
    expect(
      assertsCause("The root cause is a race condition in the writer.", "race condition"),
    ).toBe(true);
  });

  it("does NOT flag a term the write-up explicitly rules out", () => {
    // A thorough RCA names the cause and says why the alternatives are wrong.
    // A plain substring test scores that as diagnosing the alternative.
    expect(
      assertsCause("This is not a race condition: the path is single-threaded.", "race condition"),
    ).toBe(false);
    expect(assertsCause("We ruled out clock skew early.", "clock skew")).toBe(false);
  });

  it("does not flag terms under a negating heading", () => {
    const doc = [
      "## Why not the other candidates",
      "",
      "- Clock skew: the TTL uses one injected now.",
    ].join("\n");
    expect(assertsCause(doc, "clock skew")).toBe(false);
  });

  it("still flags an assertion elsewhere in a doc that also rules things out", () => {
    const doc = [
      "## Root cause",
      "The cache key omits the tenant.",
      "",
      "## Why not the other candidates",
      "- Not a race condition.",
    ].join("\n");
    expect(assertsCause(doc, "cache key")).toBe(true);
    expect(assertsCause(doc, "race condition")).toBe(false);
  });
});

const defect = (id: string, file: string, tokens: string[]): PlantedDefect => ({
  id,
  file,
  line: 1,
  severity: "high",
  category: "logic",
  tokens,
});

describe("gradeFindings — recall alone would reward a shotgun", () => {
  const planted = [
    defect("d1", "src/a.ts", ["sql injection"]),
    defect("d2", "src/b.ts", ["off-by-one"]),
  ];

  it("scores a precise, complete review at 1", () => {
    const g = gradeFindings(
      [
        { file: "src/a.ts", title: "SQL injection in query builder" },
        { file: "src/b.ts", title: "Off-by-one in the slice bound" },
      ],
      planted,
    );
    expect(g.score).toBeCloseTo(1, 6);
  });

  it("punishes a report that flags everything to catch everything", () => {
    const noise = Array.from({ length: 40 }, (_, i) => ({
      file: "src/z.ts",
      title: `possible issue ${i}`,
    }));
    const g = gradeFindings(
      [
        { file: "src/a.ts", title: "SQL injection" },
        { file: "src/b.ts", title: "off-by-one" },
        ...noise,
      ],
      planted,
    );
    expect(g.recall).toBe(1);
    expect(g.precision).toBeLessThan(0.1);
    expect(g.score).toBeLessThan(0.2);
  });

  it("does not credit a finding in the wrong file", () => {
    const g = gradeFindings([{ file: "src/other.ts", title: "SQL injection" }], planted);
    expect(g.score).toBe(0);
  });

  it("does not let one finding claim two defects", () => {
    const g = gradeFindings([{ file: "src/a.ts", title: "sql injection and off-by-one" }], planted);
    expect(g.matched).toEqual(["d1"]);
  });
});
