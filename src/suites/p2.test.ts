import { describe, expect, it } from "vitest";
import type { Attempt, ProviderResponse, TaskSpec, TrapType } from "../types.js";
import { p2Suite } from "./p2.js";

/** Graders take a GradeContext; P2 needs no judge, so pass an empty one. */
const gradeP2 = (spec: TaskSpec, a: Attempt, _ignored?: unknown) =>
  p2Suite.grade(spec, a, { judge: null, familyOf: () => "test" });

/**
 * Grader unit tests, one per trap type the report breaks scores down by.
 *
 * A grader bug invalidates every number the harness produces, so these assert
 * the trap semantics directly rather than going through a live call.
 */

function spec(
  labelSet: string,
  labels: Record<string, string | boolean | null>,
  trapType: TrapType,
): TaskSpec {
  return {
    suite: "p2",
    itemId: `t-${labelSet}-${trapType}`,
    fixtureVersion: "1",
    prompt: { user: "irrelevant for grading" },
    gold: { labelSet, labels, trapType, note: "unit test" },
    weight: 1,
  };
}

function attempt(json: unknown, over: Partial<ProviderResponse> = {}): Attempt {
  const response: ProviderResponse = {
    text: JSON.stringify(json),
    json,
    usage: { in: 10, out: 5 },
    latencyMs: 1,
    raw: {},
    paramsDropped: [],
    stopReason: "end_turn",
    ...over,
  };
  return {
    attemptId: "a1",
    runId: "r1",
    suite: "p2",
    itemId: "i1",
    modelId: "m1",
    resolvedModel: "m1",
    repeatIndex: 0,
    requestHash: "h",
    cached: false,
    response,
    error: null,
    costUsd: 0,
  };
}

const funding = (
  labels: { is_funding_event: boolean; round_stage: string | null; is_india: boolean },
  trap: TrapType,
) => spec("funding", labels, trap);

describe("p2 grader — trap coverage", () => {
  it("none: scores a fully correct plain event 1", async () => {
    const g = await gradeP2(
      funding({ is_funding_event: true, round_stage: "seed", is_india: true }, "none"),
      attempt({ is_funding_event: true, round_stage: "seed", is_india: true }),
      { judge: null },
    );
    expect(g.status).toBe("graded");
    expect(g.score).toBe(1);
    expect(g.subscores.exactMatch).toBe(1);
    expect(g.perTrap.none).toEqual({ n: 1, passed: 1 });
  });

  it("distractor: calling a non-event a funding event is wrong", async () => {
    const g = await gradeP2(
      funding({ is_funding_event: false, round_stage: null, is_india: true }, "distractor"),
      attempt({ is_funding_event: true, round_stage: "series-a", is_india: true }),
      { judge: null },
    );
    expect(g.score).toBeLessThan(1);
    expect(g.perTrap.distractor).toEqual({ n: 1, passed: 0 });
  });

  it("distractor: an entity-collision item is graded on the funded company", async () => {
    // Funded company is non-India; an India city appears elsewhere in the text.
    const g = await gradeP2(
      funding({ is_funding_event: true, round_stage: "series-c", is_india: false }, "distractor"),
      attempt({ is_funding_event: true, round_stage: "series-c", is_india: true }),
      { judge: null },
    );
    expect(g.subscores.exactMatch).toBe(0);
    expect(g.subscores.fieldsCorrect).toBe(2);
  });

  it("unit-trap: an INR amount must not make a non-India company India", async () => {
    const g = await gradeP2(
      funding({ is_funding_event: true, round_stage: "seed", is_india: false }, "unit-trap"),
      attempt({ is_funding_event: true, round_stage: "seed", is_india: true }),
      { judge: null },
    );
    expect(g.score).toBeCloseTo(2 / 3, 6);
    expect(g.perTrap["unit-trap"]).toEqual({ n: 1, passed: 0 });
  });

  it("unit-trap: a USD amount must not make an India company non-India", async () => {
    const g = await gradeP2(
      funding({ is_funding_event: true, round_stage: "seed", is_india: true }, "unit-trap"),
      attempt({ is_funding_event: true, round_stage: "seed", is_india: true }),
      { judge: null },
    );
    expect(g.score).toBe(1);
  });

  it("spelled-number: a written-out amount is still a funding event", async () => {
    const g = await gradeP2(
      funding(
        { is_funding_event: true, round_stage: "pre-seed", is_india: true },
        "spelled-number",
      ),
      attempt({ is_funding_event: true, round_stage: "pre-seed", is_india: true }),
      { judge: null },
    );
    expect(g.score).toBe(1);
    expect(g.perTrap["spelled-number"]).toEqual({ n: 1, passed: 1 });
  });

  it("absent: returning null for an undisclosed stage is correct", async () => {
    const g = await gradeP2(
      funding({ is_funding_event: true, round_stage: null, is_india: true }, "absent"),
      attempt({ is_funding_event: true, round_stage: null, is_india: true }),
      { judge: null },
    );
    expect(g.score).toBe(1);
    expect(g.violations).toHaveLength(0);
  });

  it("absent: inventing a stage that was never stated is a violation, not just a miss", async () => {
    const g = await gradeP2(
      funding({ is_funding_event: true, round_stage: null, is_india: true }, "absent"),
      attempt({ is_funding_event: true, round_stage: "series-b", is_india: true }),
      { judge: null },
    );
    expect(g.score).toBeLessThan(1);
    expect(g.violations.map((v) => v.kind)).toContain("invented-value");
    expect(g.violations[0]?.detail).toContain("never stated");
  });

  it("flags a stage asserted alongside the model's own is_funding_event=false", async () => {
    const g = await gradeP2(
      funding({ is_funding_event: false, round_stage: null, is_india: false }, "distractor"),
      attempt({ is_funding_event: false, round_stage: "seed", is_india: false }),
      { judge: null },
    );
    expect(g.violations.map((v) => v.kind)).toContain("invented-value");
  });
});

describe("p2 grader — stage normalisation", () => {
  const cases: [unknown, boolean][] = [
    ["seed", true],
    ["Seed", true],
    ["SERIES A", true],
    ["series_a", false], // underscore is not a separator we accept
    [null, false],
    ["null", false],
    ["undisclosed", false],
    ["n/a", false],
    ["", false],
  ];
  for (const [input, matchesSeed] of cases) {
    it(`treats ${JSON.stringify(input)} sensibly`, async () => {
      const g = await gradeP2(
        funding({ is_funding_event: true, round_stage: "seed", is_india: true }, "none"),
        attempt({ is_funding_event: true, round_stage: input, is_india: true }),
        { judge: null },
      );
      expect(g.subscores.exactMatch === 1).toBe(matchesSeed && input !== "SERIES A");
    });
  }

  it("maps a null-ish string to null so 'undisclosed' counts as an honest null", async () => {
    const g = await gradeP2(
      funding({ is_funding_event: true, round_stage: null, is_india: true }, "absent"),
      attempt({ is_funding_event: true, round_stage: "undisclosed", is_india: true }),
      { judge: null },
    );
    expect(g.score).toBe(1);
    expect(g.violations).toHaveLength(0);
  });
});

describe("p2 grader — other label sets", () => {
  it("grades meeting type exactly", async () => {
    const s = spec("meeting", { meeting_type: "internal" }, "distractor");
    expect((await gradeP2(s, attempt({ meeting_type: "internal" }))).score).toBe(1);
    expect((await gradeP2(s, attempt({ meeting_type: "board-call" }))).score).toBe(0);
  });

  it("grades signal vs noise exactly", async () => {
    const s = spec("signal", { classification: "noise" }, "distractor");
    expect((await gradeP2(s, attempt({ classification: "noise" }))).score).toBe(1);
    expect((await gradeP2(s, attempt({ classification: "signal" }))).score).toBe(0);
  });

  it("grades thesis fit exactly", async () => {
    const s = spec("thesis", { fit: "anti-thesis" }, "distractor");
    expect((await gradeP2(s, attempt({ fit: "anti-thesis" }))).score).toBe(1);
    expect((await gradeP2(s, attempt({ fit: "in-thesis" }))).score).toBe(0);
  });
});

describe("p2 grader — non-answers", () => {
  it("scores unparseable output 0 with a schema-invalid violation", async () => {
    const s = funding({ is_funding_event: true, round_stage: "seed", is_india: true }, "none");
    const a = attempt(undefined, { text: "I'm not sure about this one.", json: undefined });
    const g = await gradeP2(s, a);
    expect(g.score).toBe(0);
    expect(g.violations[0]?.kind).toBe("schema-invalid");
  });

  it("marks a refusal ungraded rather than scoring it 0", async () => {
    const s = funding({ is_funding_event: true, round_stage: "seed", is_india: true }, "none");
    const a = attempt(undefined, {
      json: undefined,
      refusal: { kind: "content", detail: "declined" },
    });
    const g = await gradeP2(s, a);
    expect(g.status).toBe("ungraded");
    expect(g.score).toBeNull();
  });

  it("marks a missing response ungraded", async () => {
    const s = funding({ is_funding_event: true, round_stage: "seed", is_india: true }, "none");
    const a = { ...attempt({}), response: null };
    const g = await gradeP2(s, a);
    expect(g.status).toBe("ungraded");
    expect(g.score).toBeNull();
  });
});
