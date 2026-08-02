import { createHash } from "node:crypto";
import type { Provider } from "../providers/types.js";
import { type ResponseCache, cacheKey, isCacheable } from "../runner/cache.js";
import { withRetry } from "../runner/retry.js";
import type { SpendMeter } from "../runner/spend.js";
import { type Capabilities, type JudgeEntry, type ProviderRequest, costOf } from "../types.js";

/**
 * LLM-judge infrastructure for P4 and P5.
 *
 * Design constraints, all of which exist to stop the judge quietly inventing a
 * score:
 *   - the judge model is PINNED in judges.yaml and recorded in every manifest
 *   - it is never a candidate in the same run, and by default never the same
 *     provider family as the model under test
 *   - every deduction must quote the submission; an unevidenced deduction is
 *     discarded and the criterion is marked ungraded rather than guessed
 *   - the criterion order is shuffled per item, deterministically
 *   - the candidate's identity is never shown to the judge
 */

export interface RubricCriterion {
  id: string;
  name: string;
  /** What the judge is being asked. Phrased so 5 is achievable. */
  question: string;
  /** Anchored descriptors. Vague scales produce vague scores. */
  anchors: { 1: string; 3: string; 5: string };
}

export interface Rubric {
  id: string;
  version: string;
  criteria: RubricCriterion[];
}

export interface JudgeRequest {
  itemId: string;
  /** Used only for the family-collision check; never shown to the judge. */
  candidateModelId: string;
  candidateFamily: string;
  rubric: Rubric;
  /** The source material the submission was supposed to be grounded in. */
  sourceMaterial: string;
  submission: string;
  task: string;
}

export interface CriterionVerdict {
  id: string;
  score: number | null;
  evidence: string[];
  reasoning: string;
  /** Set when a deduction arrived with no supporting quote. */
  discarded: boolean;
}

export interface JudgeOutcome {
  status: "graded" | "ungraded";
  ungradedReason: string | null;
  /** Mean of the graded criteria, normalised to 0..1. */
  score: number | null;
  perCriterion: CriterionVerdict[];
  /** Present only with --dual-judge. */
  disagreement: { maxPoints: number; flagged: boolean } | null;
  /** Set when some pinned judges errored but others produced a verdict. */
  panelDegraded: string | null;
  evidence: string[];
  costUsd: number;
}

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    criteria: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          score: { type: "integer" },
          evidence: { type: "array", items: { type: "string" } },
          reasoning: { type: "string" },
        },
        required: ["id", "score", "evidence", "reasoning"],
        additionalProperties: false,
      },
    },
  },
  required: ["criteria"],
  additionalProperties: false,
} as const;

const SYSTEM = [
  "You are grading a written submission against a rubric. You return only JSON matching the schema.",
  "",
  "Rules you must follow:",
  "- Score each criterion from 1 to 5 using the anchors given. 5 is achievable; award it when the",
  "  submission meets the criterion.",
  "- For ANY score below 5 you must quote the specific text from the submission that caused the",
  "  deduction, verbatim, in the evidence array. A deduction with no quote will be discarded.",
  "- Quote the submission, not the source material, and not your own paraphrase.",
  "- Judge only what is in front of you. You do not know which system produced the submission and",
  "  must not speculate about it.",
  "- Do not reward length. A short submission that meets the criterion scores 5.",
].join("\n");

/** Deterministic per-item shuffle, so criterion order varies but reproducibly. */
function shuffleCriteria(criteria: RubricCriterion[], itemId: string): RubricCriterion[] {
  const scored = criteria.map((c) => ({
    c,
    k: createHash("sha256").update(`${itemId}:${c.id}`).digest("hex"),
  }));
  scored.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  return scored.map((s) => s.c);
}

function buildPrompt(req: JudgeRequest): string {
  const criteria = shuffleCriteria(req.rubric.criteria, req.itemId);
  const rubricText = criteria
    .map(
      (c) =>
        `### ${c.id}\n${c.question}\n  1 = ${c.anchors[1]}\n  3 = ${c.anchors[3]}\n  5 = ${c.anchors[5]}`,
    )
    .join("\n\n");
  return [
    `## TASK THE WRITER WAS GIVEN\n${req.task}`,
    `## SOURCE MATERIAL THE WRITER WAS GIVEN\n${req.sourceMaterial}`,
    `## SUBMISSION TO GRADE\n${req.submission}`,
    `## RUBRIC\n${rubricText}`,
    `Return one entry per criterion id, using the ids exactly as written above.`,
  ].join("\n\n---\n\n");
}

export class JudgeRunner {
  constructor(
    readonly entry: JudgeEntry,
    private readonly provider: Provider,
    private readonly cache: ResponseCache | null,
    private readonly spend: SpendMeter,
    private readonly fixturesVersion: string,
    private readonly resolvedModel: string,
    private readonly caps: Capabilities,
  ) {}

  get promptHash(): string {
    return createHash("sha256").update(SYSTEM).digest("hex").slice(0, 16);
  }

  async run(
    req: JudgeRequest,
  ): Promise<{ verdicts: CriterionVerdict[]; costUsd: number } | { error: string }> {
    const request: ProviderRequest = {
      model: this.entry.id,
      system: SYSTEM,
      messages: [{ role: "user", content: buildPrompt(req) }],
      jsonSchema: JUDGE_SCHEMA as unknown as Record<string, unknown>,
      temperature: 0,
      maxTokens: 2000,
      profile: this.entry.profile,
    };

    const key = cacheKey({
      modelId: `judge:${this.entry.id}`,
      resolvedModel: this.resolvedModel,
      request,
      fixturesVersion: this.fixturesVersion,
      repeatIndex: 0,
    });

    const hit = this.cache?.get(key);
    let response = hit?.response ?? null;
    let costUsd = 0;

    if (!response) {
      if (!this.spend.reserve()) return { error: "spend cap reached before the judge could run" };
      // Resolved at preflight, never asserted here. Hardcoding temperature:true
      // is how a judge ends up 400ing on every call while the panel quietly
      // reports the other judge's scores as if they were the panel's.
      const outcome = await withRetry(() => this.provider.complete(request, this.caps));
      if (!outcome.value)
        return { error: `judge call failed: ${outcome.error?.message ?? "unknown"}` };
      response = outcome.value;
      costUsd = costOf(response.usage, this.entry.priceIn, this.entry.priceOut);
      // Judge calls count against the same cap as everything else.
      this.spend.add(costUsd);
      // A refusal caused by our own request must not be cached — see isCacheable.
      if (isCacheable(response)) {
        this.cache?.put(
          key,
          {
            modelId: `judge:${this.entry.id}`,
            resolvedModel: this.resolvedModel,
            fixturesVersion: this.fixturesVersion,
          },
          response,
          costUsd,
        );
      }
    }

    if (response.refusal) return { error: `judge refused: ${response.refusal.detail}` };

    const parsed = response.json as { criteria?: unknown } | undefined;
    if (!parsed || !Array.isArray(parsed.criteria)) {
      return { error: "judge did not return the expected shape" };
    }

    const byId = new Map<string, { score?: unknown; evidence?: unknown; reasoning?: unknown }>();
    for (const c of parsed.criteria as Record<string, unknown>[]) {
      if (typeof c.id === "string") byId.set(c.id, c);
    }

    const verdicts: CriterionVerdict[] = req.rubric.criteria.map((crit) => {
      const raw = byId.get(crit.id);
      if (!raw || typeof raw.score !== "number") {
        return {
          id: crit.id,
          score: null,
          evidence: [],
          reasoning: "judge omitted this criterion",
          discarded: true,
        };
      }
      const score = Math.max(1, Math.min(5, Math.round(raw.score)));
      const evidence = Array.isArray(raw.evidence)
        ? raw.evidence.filter((e): e is string => typeof e === "string" && e.trim() !== "")
        : [];
      const reasoning = typeof raw.reasoning === "string" ? raw.reasoning : "";

      // The rule that keeps the judge honest: a deduction without a quote from
      // the submission is not a finding, it is an opinion. Discard it.
      if (score < 5 && evidence.length === 0) {
        return {
          id: crit.id,
          score: null,
          evidence: [],
          reasoning: `deduction to ${score} discarded: no evidence quoted`,
          discarded: true,
        };
      }
      return { id: crit.id, score, evidence, reasoning, discarded: false };
    });

    return { verdicts, costUsd };
  }
}

export class JudgePanel {
  constructor(
    private readonly judges: JudgeRunner[],
    private readonly allowCollision: boolean,
  ) {}

  get ids(): string[] {
    return this.judges.map((j) => j.entry.id);
  }

  async evaluate(req: JudgeRequest): Promise<JudgeOutcome> {
    const empty: JudgeOutcome = {
      status: "ungraded",
      ungradedReason: null,
      score: null,
      perCriterion: [],
      disagreement: null,
      panelDegraded: null,
      evidence: [],
      costUsd: 0,
    };

    const usable = this.judges.filter(
      (j) => this.allowCollision || j.entry.family !== req.candidateFamily,
    );
    if (usable.length === 0) {
      return {
        ...empty,
        ungradedReason:
          `judge-family-collision: every pinned judge is in the "${req.candidateFamily}" family, ` +
          `the same family as the model under test. Pin a judge from another provider, or pass ` +
          `--allow-judge-collision to accept the weaker comparison.`,
      };
    }

    const results: { verdicts: CriterionVerdict[]; costUsd: number }[] = [];
    const errors: string[] = [];
    for (const j of usable) {
      const r = await j.run(req);
      if ("error" in r) errors.push(`${j.entry.id}: ${r.error}`);
      else results.push(r);
    }
    const costUsd = results.reduce((n, r) => n + r.costUsd, 0);
    // A panel that silently shrinks is worse than no panel: the run prints
    // "judge A + judge B", the scores come from A alone, and nothing says so.
    // Carry the shortfall out so the suite can report it.
    const degraded =
      results.length > 0 && errors.length > 0
        ? `judge panel ran ${results.length}/${usable.length}: ${errors.join("; ")}`
        : null;
    if (results.length === 0) {
      return {
        ...empty,
        ungradedReason: errors.join("; ") || "no judge produced a verdict",
        costUsd,
      };
    }

    // Average the panel per criterion; a criterion every judge discarded stays
    // discarded rather than being filled in.
    const perCriterion: CriterionVerdict[] = req.rubric.criteria.map((crit) => {
      const votes = results
        .map((r) => r.verdicts.find((v) => v.id === crit.id))
        .filter((v): v is CriterionVerdict => v !== undefined && !v.discarded && v.score !== null);
      if (votes.length === 0) {
        const first = results[0]?.verdicts.find((v) => v.id === crit.id);
        return (
          first ?? {
            id: crit.id,
            score: null,
            evidence: [],
            reasoning: "no verdict",
            discarded: true,
          }
        );
      }
      return {
        id: crit.id,
        score: votes.reduce((n, v) => n + (v.score ?? 0), 0) / votes.length,
        evidence: [...new Set(votes.flatMap((v) => v.evidence))],
        reasoning: votes.map((v) => v.reasoning).join(" | "),
        discarded: false,
      };
    });

    // Dual-judge disagreement: flagged above 2 rubric points for manual review,
    // never silently averaged away.
    let disagreement: JudgeOutcome["disagreement"] = null;
    if (results.length > 1) {
      let maxPoints = 0;
      for (const crit of req.rubric.criteria) {
        const scores = results
          .map((r) => r.verdicts.find((v) => v.id === crit.id))
          .filter((v): v is CriterionVerdict => v !== undefined && v.score !== null)
          .map((v) => v.score as number);
        if (scores.length > 1)
          maxPoints = Math.max(maxPoints, Math.max(...scores) - Math.min(...scores));
      }
      disagreement = { maxPoints, flagged: maxPoints > 2 };
    }

    const graded = perCriterion.filter((c) => !c.discarded && c.score !== null);
    if (graded.length === 0) {
      return {
        ...empty,
        ungradedReason: "every criterion was discarded for lack of evidence",
        perCriterion,
        panelDegraded: degraded,
        costUsd,
      };
    }

    // 1..5 -> 0..1
    const mean = graded.reduce((n, c) => n + (c.score as number), 0) / graded.length;
    return {
      status: "graded",
      ungradedReason: null,
      score: (mean - 1) / 4,
      perCriterion,
      disagreement,
      panelDegraded: degraded,
      evidence: perCriterion.flatMap((c) =>
        c.discarded
          ? [`${c.id}: DISCARDED — ${c.reasoning}`]
          : [
              `${c.id}=${(c.score ?? 0).toFixed(1)} ${c.evidence.length > 0 ? `“${c.evidence[0]?.slice(0, 120)}”` : ""}`,
            ],
      ),
      costUsd,
    };
  }
}
