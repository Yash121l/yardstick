import { describe, expect, it } from "vitest";
import { DEFAULT_CAPABILITIES, type Provider } from "../providers/types.js";
import { SpendMeter } from "../runner/spend.js";
import type { JudgeEntry, ProviderRequest, ProviderResponse } from "../types.js";
import { JudgePanel, type JudgeRequest, JudgeRunner, type Rubric } from "./judge.js";

const RUBRIC: Rubric = {
  id: "test",
  version: "1",
  criteria: [
    { id: "a", name: "A", question: "?", anchors: { 1: "bad", 3: "mid", 5: "good" } },
    { id: "b", name: "B", question: "?", anchors: { 1: "bad", 3: "mid", 5: "good" } },
  ],
};

class FakeJudgeProvider implements Provider {
  readonly name = "openai" as const;
  readonly envKey = "OPENAI_API_KEY";
  seen: ProviderRequest[] = [];
  seenCaps: unknown[] = [];
  constructor(private readonly reply: unknown) {}
  isConfigured() {
    return true;
  }
  async listModels() {
    return [];
  }
  async describeModel() {
    return null;
  }
  async complete(req: ProviderRequest, caps?: unknown): Promise<ProviderResponse> {
    this.seen.push(req);
    this.seenCaps.push(caps);
    return {
      text: JSON.stringify(this.reply),
      json: this.reply,
      usage: { in: 100, out: 50 },
      latencyMs: 1,
      raw: {},
      paramsDropped: [],
      stopReason: "end_turn",
    };
  }
}

const entry = (id: string, family: string): JudgeEntry =>
  ({
    id,
    provider: family === "openai" ? "openai" : "anthropic",
    family,
    priceIn: 1,
    priceOut: 1,
    profile: { thinking: "default", effort: null },
  }) as JudgeEntry;

function runner(reply: unknown, family = "openai", capsOver: Record<string, unknown> = {}) {
  const provider = new FakeJudgeProvider(reply);
  return {
    provider,
    runner: new JudgeRunner(
      entry("judge-x", family),
      provider,
      null,
      new SpendMeter(10),
      "1",
      "judge-x",
      { ...DEFAULT_CAPABILITIES, temperature: true, ...capsOver },
    ),
  };
}

/** A judge that always fails, to model one half of a two-judge panel dying. */
class DeadJudgeProvider extends FakeJudgeProvider {
  override async complete(): Promise<ProviderResponse> {
    throw new Error("`temperature` is not supported by this model");
  }
}

const req = (over: Partial<JudgeRequest> = {}): JudgeRequest => ({
  itemId: "i1",
  candidateModelId: "cand",
  candidateFamily: "anthropic",
  rubric: RUBRIC,
  sourceMaterial: "the source",
  submission: "the submission",
  task: "write something",
  ...over,
});

describe("JudgeRunner — evidence discipline", () => {
  it("keeps a full-marks criterion with no evidence", async () => {
    const { runner: r } = runner({
      criteria: [
        { id: "a", score: 5, evidence: [], reasoning: "meets it" },
        { id: "b", score: 5, evidence: [], reasoning: "meets it" },
      ],
    });
    const out = await r.run(req());
    if ("error" in out) throw new Error(out.error);
    expect(out.verdicts.every((v) => !v.discarded)).toBe(true);
  });

  it("DISCARDS a deduction that quotes nothing", async () => {
    // The rule that keeps the judge honest: an unevidenced deduction is an
    // opinion, not a finding.
    const { runner: r } = runner({
      criteria: [
        { id: "a", score: 2, evidence: [], reasoning: "felt weak" },
        { id: "b", score: 5, evidence: [], reasoning: "fine" },
      ],
    });
    const out = await r.run(req());
    if ("error" in out) throw new Error(out.error);
    const a = out.verdicts.find((v) => v.id === "a")!;
    expect(a.discarded).toBe(true);
    expect(a.score).toBeNull();
    expect(a.reasoning).toContain("no evidence quoted");
  });

  it("keeps a deduction that does quote the submission", async () => {
    const { runner: r } = runner({
      criteria: [
        { id: "a", score: 2, evidence: ["it is important to note that"], reasoning: "filler" },
        { id: "b", score: 5, evidence: [], reasoning: "fine" },
      ],
    });
    const out = await r.run(req());
    if ("error" in out) throw new Error(out.error);
    const a = out.verdicts.find((v) => v.id === "a")!;
    expect(a.discarded).toBe(false);
    expect(a.score).toBe(2);
  });

  it("marks a criterion the judge omitted as discarded, not as zero", async () => {
    const { runner: r } = runner({
      criteria: [{ id: "a", score: 5, evidence: [], reasoning: "" }],
    });
    const out = await r.run(req());
    if ("error" in out) throw new Error(out.error);
    const b = out.verdicts.find((v) => v.id === "b")!;
    expect(b.discarded).toBe(true);
    expect(b.score).toBeNull();
  });

  it("clamps an out-of-range score rather than trusting it", async () => {
    const { runner: r } = runner({
      criteria: [
        { id: "a", score: 9, evidence: [], reasoning: "" },
        { id: "b", score: -3, evidence: ["x"], reasoning: "" },
      ],
    });
    const out = await r.run(req());
    if ("error" in out) throw new Error(out.error);
    expect(out.verdicts.find((v) => v.id === "a")?.score).toBe(5);
    expect(out.verdicts.find((v) => v.id === "b")?.score).toBe(1);
  });

  it("never shows the judge which model produced the submission", async () => {
    const { provider, runner: r } = runner({
      criteria: [{ id: "a", score: 5, evidence: [], reasoning: "" }],
    });
    await r.run(req({ candidateModelId: "claude-secret-9" }));
    const sent = JSON.stringify(provider.seen[0]);
    expect(sent).not.toContain("claude-secret-9");
  });

  it("hands the provider its RESOLVED capabilities, never an asserted all-true set", async () => {
    // Asserting temperature:true here is exactly how a judge ends up 400ing on
    // every call: the adapter is told it may send a param the model rejects,
    // the panel silently shrinks to one judge, and the scores look normal.
    const { provider, runner: r } = runner({ criteria: [] }, "openai", { temperature: false });
    await r.run(req());
    expect((provider.seenCaps[0] as { temperature: boolean }).temperature).toBe(false);
  });

  it("sends temperature 0", async () => {
    const { provider, runner: r } = runner({ criteria: [] });
    await r.run(req());
    expect(provider.seen[0]?.temperature).toBe(0);
  });

  it("reports a malformed judge reply as an error rather than a score", async () => {
    const { runner: r } = runner({ nonsense: true });
    const out = await r.run(req());
    expect("error" in out).toBe(true);
  });
});

describe("JudgePanel — collisions and disagreement", () => {
  const ok = {
    criteria: [
      { id: "a", score: 5, evidence: [], reasoning: "" },
      { id: "b", score: 5, evidence: [], reasoning: "" },
    ],
  };

  it("refuses to grade with a same-family judge by default", async () => {
    const { runner: r } = runner(ok, "anthropic");
    const panel = new JudgePanel([r], false);
    const out = await panel.evaluate(req({ candidateFamily: "anthropic" }));
    expect(out.status).toBe("ungraded");
    expect(out.ungradedReason).toContain("judge-family-collision");
    expect(out.score).toBeNull();
  });

  it("permits a same-family judge when explicitly allowed", async () => {
    const { runner: r } = runner(ok, "anthropic");
    const panel = new JudgePanel([r], true);
    const out = await panel.evaluate(req({ candidateFamily: "anthropic" }));
    expect(out.status).toBe("graded");
  });

  it("grades normally when the families differ", async () => {
    const { runner: r } = runner(ok, "openai");
    const panel = new JudgePanel([r], false);
    const out = await panel.evaluate(req({ candidateFamily: "anthropic" }));
    expect(out.status).toBe("graded");
    expect(out.score).toBe(1); // 5/5 -> 1.0
  });

  it("normalises the 1-5 scale to 0-1", async () => {
    const { runner: r } = runner({
      criteria: [
        { id: "a", score: 3, evidence: ["x"], reasoning: "" },
        { id: "b", score: 3, evidence: ["y"], reasoning: "" },
      ],
    });
    const out = await new JudgePanel([r], false).evaluate(req());
    expect(out.score).toBeCloseTo(0.5, 6);
  });

  it("averages two judges and flags a disagreement above 2 points", async () => {
    const a = runner({
      criteria: [
        { id: "a", score: 5, evidence: [], reasoning: "" },
        { id: "b", score: 5, evidence: [], reasoning: "" },
      ],
    }).runner;
    const b = runner({
      criteria: [
        { id: "a", score: 1, evidence: ["bad bit"], reasoning: "" },
        { id: "b", score: 5, evidence: [], reasoning: "" },
      ],
    }).runner;
    const out = await new JudgePanel([a, b], false).evaluate(req());
    expect(out.disagreement?.maxPoints).toBe(4);
    expect(out.disagreement?.flagged).toBe(true);
    // Averaged, not silently taking one side.
    expect(out.perCriterion.find((c) => c.id === "a")?.score).toBe(3);
  });

  it("does not flag a one-point difference", async () => {
    const a = runner({
      criteria: [
        { id: "a", score: 5, evidence: [], reasoning: "" },
        { id: "b", score: 5, evidence: [], reasoning: "" },
      ],
    }).runner;
    const b = runner({
      criteria: [
        { id: "a", score: 4, evidence: ["x"], reasoning: "" },
        { id: "b", score: 5, evidence: [], reasoning: "" },
      ],
    }).runner;
    const out = await new JudgePanel([a, b], false).evaluate(req());
    expect(out.disagreement?.flagged).toBe(false);
  });

  it("reports a panel that silently shrank rather than passing off one judge as two", async () => {
    const alive = runner(ok).runner;
    const dead = new JudgeRunner(
      entry("judge-dead", "openai"),
      new DeadJudgeProvider(ok),
      null,
      new SpendMeter(10),
      "1",
      "judge-dead",
      DEFAULT_CAPABILITIES,
    );
    const out = await new JudgePanel([alive, dead], false).evaluate(req());
    expect(out.status).toBe("graded");
    expect(out.panelDegraded).toContain("judge panel ran 1/2");
    expect(out.panelDegraded).toContain("judge-dead");
    // One judge cannot disagree with itself, and must not claim agreement.
    expect(out.disagreement).toBeNull();
  });

  it("returns ungraded when every criterion was discarded", async () => {
    const { runner: r } = runner({
      criteria: [
        { id: "a", score: 2, evidence: [], reasoning: "" },
        { id: "b", score: 1, evidence: [], reasoning: "" },
      ],
    });
    const out = await new JudgePanel([r], false).evaluate(req());
    expect(out.status).toBe("ungraded");
    expect(out.ungradedReason).toContain("discarded");
  });

  it("scores on the surviving criteria when only some are discarded", async () => {
    const { runner: r } = runner({
      criteria: [
        { id: "a", score: 2, evidence: [], reasoning: "" }, // discarded
        { id: "b", score: 5, evidence: [], reasoning: "" }, // kept
      ],
    });
    const out = await new JudgePanel([r], false).evaluate(req());
    expect(out.status).toBe("graded");
    expect(out.score).toBe(1);
    expect(out.evidence.some((e) => e.includes("DISCARDED"))).toBe(true);
  });
});
