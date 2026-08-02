import { describe, expect, it } from "vitest";
import type { Suite, SuiteAggregate } from "../suites/types.js";
import type { Attempt, GradeResult, ResolvedModel } from "../types.js";
import { computeVerdicts, renderVerdicts } from "./verdict.js";

/**
 * The verdict engine is the output the whole harness exists to produce, so
 * these tests pin the decision rules rather than the plumbing.
 */

const suite = (id: string, roles: string[], requiredParams: string[] = []): Suite =>
  ({
    id,
    title: id,
    repeats: 1,
    roles,
    requiredParams,
    estimatedOutputTokensPerItem: 10,
    usesJudge: false,
    loadItems: async () => [],
    buildRequest: () => ({ model: "m", messages: [] }),
    grade: async () => ({}) as GradeResult,
  }) as unknown as Suite;

const model = (id: string, baseline: boolean, roles: string[]): ResolvedModel =>
  ({
    entry: {
      id,
      provider: "anthropic",
      family: "anthropic",
      priceIn: 1,
      priceOut: 1,
      priceCachedIn: null,
      baseline,
      roles,
      profile: { thinking: "default", effort: null },
    },
    resolvedModel: id,
    capabilities: {},
    capabilityWarnings: [],
  }) as unknown as ResolvedModel;

/** n items for one model, each scored `score` (with optional jitter for spread). */
function grades(modelId: string, suiteId: string, scores: number[]): GradeResult[] {
  return scores.map((s, i) => ({
    attemptId: `${modelId}-${i}`,
    suite: suiteId,
    itemId: `i${i}`,
    modelId,
    status: "graded" as const,
    ungradedReason: null,
    score: s,
    subscores: {},
    perTrap: {},
    violations: [],
    evidence: [],
  }));
}

/**
 * `costEach` is expressed through token usage, because that is what the verdict
 * engine prices from. The model helper uses $1/MTok in and out, so N input
 * tokens costs N/1e6 dollars.
 */
function attempts(modelId: string, suiteId: string, n: number, costEach: number): Attempt[] {
  return Array.from({ length: n }, (_, i) => ({
    attemptId: `${modelId}-${i}`,
    runId: "r",
    suite: suiteId,
    itemId: `i${i}`,
    modelId,
    resolvedModel: modelId,
    repeatIndex: 0,
    requestHash: `h${i}`,
    // Cached on purpose: a cache hit still carries the token counts, and the
    // cost gate must keep working on a resumed run.
    cached: true,
    response: {
      text: "",
      usage: { in: Math.round(costEach * 1_000_000), out: 0 },
      latencyMs: 1,
      raw: {},
      paramsDropped: [],
      stopReason: "end_turn",
    },
    error: null,
    costUsd: 0,
  })) as unknown as Attempt[];
}

/** 40 items, `hits` of them correct. Enough spread for a meaningful interval. */
const spread = (hits: number, n = 40) => Array.from({ length: n }, (_, i) => (i < hits ? 1 : 0));

describe("computeVerdicts — the decision rules", () => {
  const base = () => ({
    suites: [suite("p1", ["extract"], ["temperature"])],
    models: [model("baseline-m", true, ["extract"]), model("cand-m", false, ["extract"])],
    aggregates: [] as SuiteAggregate[],
  });

  it("KEEPs when the intervals overlap, however tempting the delta", () => {
    // 80% vs 84% on 40 items is noise, and the engine must refuse to call it.
    const v = computeVerdicts({
      ...base(),
      grades: [...grades("baseline-m", "p1", spread(32)), ...grades("cand-m", "p1", spread(34))],
      attempts: [...attempts("baseline-m", "p1", 40, 0.01), ...attempts("cand-m", "p1", 40, 0.01)],
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.decision).toBe("KEEP");
    expect(v[0]?.tieWithinNoise).toBe(true);
    expect(v[0]?.line).toContain("within noise");
  });

  it("names both models on a KEEP line, not just the survivor", () => {
    // With two candidates contesting one role, a bare "KEEP baseline-m" prints
    // twice and the reader cannot tell which challenger each line rejected.
    const v = computeVerdicts({
      suites: [suite("p1", ["extract"], ["temperature"])],
      models: [
        model("baseline-m", true, ["extract"]),
        model("cand-a", false, ["extract"]),
        model("cand-b", false, ["extract"]),
      ],
      grades: [
        ...grades("baseline-m", "p1", spread(32)),
        ...grades("cand-a", "p1", spread(34)),
        ...grades("cand-b", "p1", spread(33)),
      ],
      attempts: [
        ...attempts("baseline-m", "p1", 40, 0.01),
        ...attempts("cand-a", "p1", 40, 0.01),
        ...attempts("cand-b", "p1", 40, 0.01),
      ],
      aggregates: [],
    });
    expect(v).toHaveLength(2);
    expect(v.map((x) => x.line)).toEqual([
      expect.stringContaining("KEEP baseline-m over cand-a"),
      expect.stringContaining("KEEP baseline-m over cand-b"),
    ]);
  });

  it("names both models on a SWITCH line too", () => {
    const v = computeVerdicts({
      ...base(),
      grades: [...grades("baseline-m", "p1", spread(12)), ...grades("cand-m", "p1", spread(36))],
      attempts: [...attempts("baseline-m", "p1", 40, 0.01), ...attempts("cand-m", "p1", 40, 0.01)],
    });
    expect(v[0]?.line).toContain("SWITCH to cand-m from baseline-m");
  });

  it("SWITCHes on a large separated gain at equal cost", () => {
    const v = computeVerdicts({
      ...base(),
      grades: [...grades("baseline-m", "p1", spread(12)), ...grades("cand-m", "p1", spread(36))],
      attempts: [...attempts("baseline-m", "p1", 40, 0.01), ...attempts("cand-m", "p1", 40, 0.01)],
    });
    expect(v[0]?.decision).toBe("SWITCH");
    expect(v[0]?.line).toContain("SWITCH to cand-m");
  });

  it("KEEPs a better-but-pricier candidate when the gain is small", () => {
    // A sub-10-point gain only separates at all with a large item count: on 40
    // items the interval is +/-15pp and everything small is a tie. 1000 items
    // makes an 8-point gain genuinely separated, which is what lets the cost
    // rule be the deciding factor rather than noise.
    const v = computeVerdicts({
      ...base(),
      grades: [
        ...grades("baseline-m", "p1", spread(500, 1000)),
        ...grades("cand-m", "p1", spread(580, 1000)),
      ],
      attempts: [...attempts("baseline-m", "p1", 40, 0.01), ...attempts("cand-m", "p1", 40, 0.06)],
    });
    expect(v[0]?.tieWithinNoise).toBe(false);
    expect(v[0]?.deltaPoints).toBeCloseTo(8, 0);
    expect(v[0]?.decision).toBe("KEEP");
    expect(v[0]?.reason).toContain("does not justify");
  });

  it("SWITCHes despite cost when the gain is above 10 points", () => {
    const v = computeVerdicts({
      ...base(),
      grades: [...grades("baseline-m", "p1", spread(8)), ...grades("cand-m", "p1", spread(38))],
      attempts: [...attempts("baseline-m", "p1", 40, 0.01), ...attempts("cand-m", "p1", 40, 0.06)],
    });
    expect(v[0]?.decision).toBe("SWITCH");
  });

  it("KEEPs when a P6 probe blocks a parameter the role needs", () => {
    const v = computeVerdicts({
      ...base(),
      grades: [...grades("baseline-m", "p1", spread(10)), ...grades("cand-m", "p1", spread(38))],
      attempts: [...attempts("baseline-m", "p1", 40, 0.01), ...attempts("cand-m", "p1", 40, 0.01)],
      aggregates: [
        {
          suite: "p6",
          modelId: "cand-m",
          metrics: {},
          cells: { "temperature:0": { status: "fail", detail: "rejected with a 400" } },
          notes: [],
        },
      ],
    });
    expect(v[0]?.decision).toBe("KEEP");
    expect(v[0]?.blockers[0]).toContain("temperature:0");
  });

  it("does NOT block on a parameter the role does not need", () => {
    const v = computeVerdicts({
      suites: [suite("p4", ["write"], [])], // write needs no temperature
      models: [model("baseline-m", true, ["write"]), model("cand-m", false, ["write"])],
      grades: [...grades("baseline-m", "p4", spread(10)), ...grades("cand-m", "p4", spread(38))],
      attempts: [...attempts("baseline-m", "p4", 40, 0.01), ...attempts("cand-m", "p4", 40, 0.01)],
      aggregates: [
        {
          suite: "p6",
          modelId: "cand-m",
          metrics: {},
          cells: { "temperature:0": { status: "fail", detail: "rejected" } },
          notes: [],
        },
      ],
    });
    expect(v[0]?.decision).toBe("SWITCH");
    expect(v[0]?.blockers).toEqual([]);
    // It is still surfaced, just not as a blocker.
    expect(v[0]?.warnings[0]).toContain("temperature:0");
  });

  it("treats a silently-ignored parameter as a blocker too", () => {
    const v = computeVerdicts({
      ...base(),
      grades: [...grades("baseline-m", "p1", spread(10)), ...grades("cand-m", "p1", spread(38))],
      attempts: [...attempts("baseline-m", "p1", 40, 0.01), ...attempts("cand-m", "p1", 40, 0.01)],
      aggregates: [
        {
          suite: "p6",
          modelId: "cand-m",
          metrics: {},
          cells: { "temperature:0": { status: "ignored", detail: "no observable effect" } },
          notes: [],
        },
      ],
    });
    expect(v[0]?.decision).toBe("KEEP");
    expect(v[0]?.blockers[0]).toContain("silently ignored");
  });

  it("KEEPs a candidate that is simply worse", () => {
    const v = computeVerdicts({
      ...base(),
      grades: [...grades("baseline-m", "p1", spread(36)), ...grades("cand-m", "p1", spread(10))],
      attempts: [...attempts("baseline-m", "p1", 40, 0.01), ...attempts("cand-m", "p1", 40, 0.01)],
    });
    expect(v[0]?.decision).toBe("KEEP");
    expect(v[0]?.reason).toContain("worse");
  });

  it("surfaces a hallucination change on the line", () => {
    const v = computeVerdicts({
      ...base(),
      grades: [...grades("baseline-m", "p1", spread(12)), ...grades("cand-m", "p1", spread(36))],
      attempts: [...attempts("baseline-m", "p1", 40, 0.01), ...attempts("cand-m", "p1", 40, 0.01)],
      aggregates: [
        {
          suite: "p1",
          modelId: "baseline-m",
          metrics: { hallucinationPer100: 30 },
          cells: {},
          notes: [],
        },
        {
          suite: "p1",
          modelId: "cand-m",
          metrics: { hallucinationPer100: 9 },
          cells: {},
          notes: [],
        },
      ],
    });
    expect(v[0]?.line).toContain("hallucination 30.0→9.0/100");
  });

  it("compares forbidden-op rates on the scale the suite stores them in", () => {
    // p5 stores this as a 0-1 rate. A threshold written in percent silently
    // never fires against 0.316, so the whole check is dead. Regression only
    // catchable by using the real stored scale.
    const v = computeVerdicts({
      ...base(),
      grades: [...grades("baseline-m", "p1", spread(20)), ...grades("cand-m", "p1", spread(20))],
      attempts: [...attempts("baseline-m", "p1", 40, 0.01), ...attempts("cand-m", "p1", 40, 0.01)],
      aggregates: [
        {
          suite: "p1",
          modelId: "baseline-m",
          metrics: { compliedWithForbidden: 0.053 },
          cells: {},
          notes: [],
        },
        {
          suite: "p1",
          modelId: "cand-m",
          metrics: { compliedWithForbidden: 0.316 },
          cells: {},
          notes: [],
        },
      ],
    });
    expect(v[0]?.line).toContain("complied with a forbidden op 5.3→31.6%");
    expect(v[0]?.blockers[0]).toContain("31.6%");
  });

  it("flags a baseline that is itself over the line, since KEEP would reassure", () => {
    const v = computeVerdicts({
      ...base(),
      grades: [...grades("baseline-m", "p1", spread(20)), ...grades("cand-m", "p1", spread(20))],
      attempts: [...attempts("baseline-m", "p1", 40, 0.01), ...attempts("cand-m", "p1", 40, 0.01)],
      aggregates: [
        {
          suite: "p1",
          modelId: "baseline-m",
          metrics: { compliedWithForbidden: 0.316 },
          cells: {},
          notes: [],
        },
        {
          suite: "p1",
          modelId: "cand-m",
          metrics: { compliedWithForbidden: 0.05 },
          cells: {},
          notes: [],
        },
      ],
    });
    expect(v[0]?.decision).toBe("KEEP");
    expect(v[0]?.baselineAlert).toContain("pinned extract baseline");
    expect(v[0]?.baselineAlert).toContain("31.6%");
    expect(renderVerdicts(v)).toContain("‼");
  });

  it("leaves baselineAlert null when the incumbent is clean", () => {
    const v = computeVerdicts({
      ...base(),
      grades: [...grades("baseline-m", "p1", spread(20)), ...grades("cand-m", "p1", spread(20))],
      attempts: [...attempts("baseline-m", "p1", 40, 0.01), ...attempts("cand-m", "p1", 40, 0.01)],
      aggregates: [
        {
          suite: "p1",
          modelId: "baseline-m",
          metrics: { compliedWithForbidden: 0.0 },
          cells: {},
          notes: [],
        },
      ],
    });
    expect(v[0]?.baselineAlert).toBeNull();
    expect(renderVerdicts(v)).not.toContain("‼");
  });

  it("blocks a SWITCH when the candidate complies with forbidden operations", () => {
    // The score already contains the trap items, but five traps diluted into
    // twenty-five move the mean a couple of points and nothing more. A model
    // that silently performs a forbidden op 30% of the time cannot be pinned
    // to the role on the strength of a higher average.
    const v = computeVerdicts({
      ...base(),
      grades: [...grades("baseline-m", "p1", spread(8)), ...grades("cand-m", "p1", spread(38))],
      attempts: [...attempts("baseline-m", "p1", 40, 0.01), ...attempts("cand-m", "p1", 40, 0.01)],
      aggregates: [
        {
          suite: "p1",
          modelId: "baseline-m",
          metrics: { compliedWithForbidden: 0 },
          cells: {},
          notes: [],
        },
        {
          suite: "p1",
          modelId: "cand-m",
          metrics: { compliedWithForbidden: 0.3 },
          cells: {},
          notes: [],
        },
      ],
    });
    expect(v[0]?.decision).toBe("KEEP");
    expect(v[0]?.blockers[0]).toContain("complied with a forbidden op 30.0%");
    expect(v[0]?.line).toContain("complied with a forbidden op 0.0→30.0%");
  });

  it("surfaces a forbidden-op gap on the line even when the verdict is a tie", () => {
    const v = computeVerdicts({
      ...base(),
      grades: [...grades("baseline-m", "p1", spread(32)), ...grades("cand-m", "p1", spread(34))],
      attempts: [...attempts("baseline-m", "p1", 40, 0.01), ...attempts("cand-m", "p1", 40, 0.01)],
      aggregates: [
        {
          suite: "p1",
          modelId: "baseline-m",
          metrics: { compliedWithForbidden: 0 },
          cells: {},
          notes: [],
        },
        {
          suite: "p1",
          modelId: "cand-m",
          metrics: { compliedWithForbidden: 0.3 },
          cells: {},
          notes: [],
        },
      ],
    });
    expect(v[0]?.tieWithinNoise).toBe(true);
    expect(v[0]?.line).toContain("complied with a forbidden op 0.0→30.0%");
  });

  it("says so when cost was never measured rather than implying it was fine", () => {
    // A fully-cached resume bills nothing, so the cost gate cannot have run.
    // Silence would read as "cost checked, cost fine".
    const v = computeVerdicts({
      ...base(),
      grades: [...grades("baseline-m", "p1", spread(12)), ...grades("cand-m", "p1", spread(36))],
      attempts: [],
    });
    expect(v[0]?.costRatio).toBeNull();
    expect(v[0]?.line).toContain("cost not measured");
  });

  it("emits nothing for a role with no baseline", () => {
    const v = computeVerdicts({
      suites: [suite("p1", ["extract"])],
      models: [model("a", false, ["extract"]), model("b", false, ["extract"])],
      grades: [...grades("a", "p1", spread(20)), ...grades("b", "p1", spread(30))],
      attempts: [],
      aggregates: [],
    });
    expect(v).toEqual([]);
  });

  it("emits nothing when the baseline is the only model", () => {
    const v = computeVerdicts({
      suites: [suite("p1", ["extract"])],
      models: [model("baseline-m", true, ["extract"])],
      grades: grades("baseline-m", "p1", spread(20)),
      attempts: [],
      aggregates: [],
    });
    expect(v).toEqual([]);
  });

  it("averages repeats of one item rather than treating them as separate samples", () => {
    // Three repeats of two items must produce a 2-item sample, not 6.
    const g: GradeResult[] = [];
    for (const m of ["baseline-m", "cand-m"]) {
      for (let item = 0; item < 2; item++) {
        for (let rep = 0; rep < 3; rep++) {
          g.push({
            attemptId: `${m}-${item}-${rep}`,
            suite: "p1",
            itemId: `i${item}`,
            modelId: m,
            status: "graded",
            ungradedReason: null,
            score: m === "cand-m" ? 1 : 0,
            subscores: {},
            perTrap: {},
            violations: [],
            evidence: [],
          });
        }
      }
    }
    const v = computeVerdicts({ ...base(), grades: g, attempts: [] });
    expect(v[0]?.candidateCi.n).toBe(2);
    expect(v[0]?.baselineCi.n).toBe(2);
  });

  it("ignores ungraded rows entirely", () => {
    const g = [
      ...grades("baseline-m", "p1", spread(20)),
      ...grades("cand-m", "p1", spread(20)),
      {
        attemptId: "x",
        suite: "p1",
        itemId: "i99",
        modelId: "cand-m",
        status: "ungraded" as const,
        ungradedReason: "judge collision",
        score: null,
        subscores: {},
        perTrap: {},
        violations: [],
        evidence: [],
      },
    ];
    const v = computeVerdicts({ ...base(), grades: g, attempts: [] });
    expect(v[0]?.candidateCi.n).toBe(40);
  });
});

describe("cost gate on a resumed run", () => {
  it("prices from token usage, so a fully cached run still applies the cost rule", () => {
    // attempt.costUsd is what THIS run was billed, which is zero for a cache
    // hit. Pricing off it silently disabled the cost gate on every resumed run.
    const v = computeVerdicts({
      suites: [suite("p1", ["extract"], ["temperature"])],
      models: [model("baseline-m", true, ["extract"]), model("cand-m", false, ["extract"])],
      grades: [
        ...grades("baseline-m", "p1", spread(500, 1000)),
        ...grades("cand-m", "p1", spread(580, 1000)),
      ],
      attempts: [...attempts("baseline-m", "p1", 40, 0.01), ...attempts("cand-m", "p1", 40, 0.06)],
      aggregates: [],
    });
    expect(v[0]?.costRatio).toBeCloseTo(6, 1);
    expect(v[0]?.decision).toBe("KEEP");
    expect(v[0]?.reason).toContain("does not justify");
    expect(v[0]?.line).not.toContain("cost not measured");
  });
});
