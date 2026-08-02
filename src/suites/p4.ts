import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type DocType,
  IC_MEMO_SECTIONS,
  LENGTH_CAPS,
  type P4Pack,
  mentionsNews,
} from "../generators/p4.js";
import type { Rubric } from "../graders/judge.js";
import { extractNumericTokens, parseQuantity } from "../graders/normalize.js";
import { percentile } from "../graders/stats.js";
import type { Attempt, GradeResult, ProviderRequest, TaskSpec, Violation } from "../types.js";
import {
  type AggregateInput,
  type GradeContext,
  type Suite,
  type SuiteAggregate,
  type SuiteContext,
  ungraded,
} from "./types.js";

const TASKS: Record<DocType, string> = {
  "ic-memo": [
    "Write an investment committee memo skeleton for the company below.",
    "",
    "Use exactly these nine section headings, in this order, each on its own line as a markdown heading:",
    ...IC_MEMO_SECTIONS.map((s) => `## ${s}`),
    "",
    `Hard limit: ${LENGTH_CAPS["ic-memo"]} words. Crisp beats comprehensive.`,
    "Every figure you state must come from the pack. Do not compute, estimate or import figures",
    "from anywhere else, except inside Return scenarios where projections are expected.",
    "Where you draw an inference rather than repeating something stated, mark it as an inference.",
  ].join("\n"),
  "delta-brief": [
    "Write a delta brief: what is NEW since the investment committee was last updated.",
    "",
    "The pack ends with a list of what has already been reported to the committee. Anything on that",
    "list is not news. Do not restate it, summarise it, or refer back to it.",
    "",
    `Hard limit: ${LENGTH_CAPS["delta-brief"]} words.`,
    "Every figure you state must appear in the pack.",
  ].join("\n"),
  "digest-email": [
    "Write a short internal digest email covering the recent news in the pack.",
    "",
    `Hard limit: ${LENGTH_CAPS["digest-email"]} words.`,
    "Plain and direct. No preamble, no sign-off flourish, no invented endorsements.",
    "Every figure you state must appear in the pack.",
  ].join("\n"),
};

export const P4_RUBRIC: Rubric = {
  id: "p4-writing",
  version: "1",
  criteria: [
    {
      id: "groundedness",
      name: "Claim-level groundedness",
      question:
        "Is every factual claim in the submission supported by the source material? Ignore section headings and formatting.",
      anchors: {
        1: "Contains claims that contradict the source, or several claims with no basis in it at all.",
        3: "Mostly grounded, but at least one claim goes beyond what the source supports.",
        5: "Every factual claim traces to the source material.",
      },
    },
    {
      id: "inference_marking",
      name: "Inferred vs stated",
      question:
        "Where the submission draws a conclusion the source does not state outright, is it presented as an inference rather than as a fact?",
      anchors: {
        1: "Inferences are asserted as established facts with no signalling at all.",
        3: "Some inferences are signalled, others are asserted flatly.",
        5: "Every inference is clearly marked as such, or the submission makes none.",
      },
    },
    {
      id: "internal_consistency",
      name: "Internal consistency",
      question:
        "Is the submission consistent with itself — in particular, does any recommendation or conclusion follow from the evidence the submission itself presents?",
      anchors: {
        1: "The conclusion contradicts the evidence presented alongside it.",
        3: "The conclusion is defensible but sits awkwardly with some of the evidence given.",
        5: "The conclusion follows from the evidence the submission presents.",
      },
    },
    {
      id: "tone",
      name: "Plain and direct",
      question:
        "Is the writing plain and direct, free of hedging filler, throat-clearing and padding?",
      anchors: {
        1: "Dense with filler: 'it is important to note', 'as we all know', long windups before any content.",
        3: "Readable but padded in places.",
        5: "Direct throughout; every sentence carries content.",
      },
    },
    {
      id: "no_social_proof",
      name: "No fabricated social proof",
      question:
        "Does the submission avoid inventing endorsements, customer names, investor interest, analyst opinion or market validation that the source does not contain?",
      anchors: {
        1: "Invents named endorsements, customers or third-party validation.",
        3: "Implies external validation the source does not establish.",
        5: "Makes no claim of external validation beyond what the source states.",
      },
    },
  ],
};

interface P4GoldPayload {
  packId: string;
  docType: DocType;
  packText: string;
  numbers: P4Pack["numbers"];
  news: P4Pack["news"];
  previouslyReported: string[];
  task: string;
}

let cached: TaskSpec[] | null = null;

function load(ctx: SuiteContext): TaskSpec[] {
  if (cached) return cached;
  const dir = join(ctx.root, "suites", "p4-writing");
  const fx = JSON.parse(readFileSync(join(dir, "fixtures", "packs.json"), "utf8")) as {
    packs: P4Pack[];
  };

  const specs: TaskSpec[] = [];
  for (const pack of fx.packs) {
    for (const docType of ["ic-memo", "delta-brief", "digest-email"] as DocType[]) {
      specs.push({
        suite: "p4",
        itemId: `${pack.id}-${docType}`,
        fixtureVersion: ctx.fixturesVersion,
        prompt: {
          system:
            "You write for a venture capital investment committee. You are precise, you do not pad, " +
            "and you never state a figure or a fact that is not in the material you were given.",
          user: `${TASKS[docType]}\n\n--- PACK ---\n${pack.text}`,
        },
        requestOverrides: { temperature: 0, maxTokens: 2000 },
        gold: {
          packId: pack.id,
          docType,
          packText: pack.text,
          numbers: pack.numbers,
          news: pack.news,
          previouslyReported: pack.previouslyReported,
          task: TASKS[docType],
        } satisfies P4GoldPayload,
        weight: 1,
      });
    }
  }
  cached = ctx.maxItems === null ? specs : takeAcrossDocTypes(specs, ctx.maxItems);
  return cached;
}

function takeAcrossDocTypes(specs: TaskSpec[], perType: number): TaskSpec[] {
  const seen: Record<string, number> = {};
  return specs.filter((s) => {
    const t = (s.gold as P4GoldPayload).docType;
    seen[t] = (seen[t] ?? 0) + 1;
    return seen[t] <= perType;
  });
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Which numbers in the output must trace back to the pack.
 *
 * Bare integers of 10 or less are excluded: they are list markers, "three
 * risks", "the nine sections". What is checked is every figure that carries a
 * currency, a percentage, a scale word or a duration, plus any bare number
 * large enough to be a claim. Return-scenario projections are excluded by the
 * caller, because the memo explicitly asks for them.
 */
function claimNumbers(text: string): { raw: string; value: number; unit: string }[] {
  const out: { raw: string; value: number; unit: string }[] = [];
  const re =
    /(?:₹|\$)\s?[\d,]+(?:\.\d+)?\s*(?:crores?|lakhs?|millions?|billions?|thousands?|mn|bn|k|m)?|[\d,]+(?:\.\d+)?\s*(?:crores?|lakhs?|millions?|billions?|thousands?|mn|bn|%|percent|per cent|percentage points?|pp|months?|years?|people|employees|customers|x)\b|\b\d{2,}\b/gi;
  for (const m of text.matchAll(re)) {
    const raw = m[0].trim();
    const q = parseQuantity(raw);
    if (q.value === null) continue;
    if (q.unit === "unknown" && Math.abs(q.value) <= 10) continue;
    out.push({ raw, value: q.value, unit: q.unit });
  }
  return out;
}

/** Strip the Return scenarios section, where projections are legitimate. */
function stripReturnScenarios(text: string): string {
  const idx = text.search(/^#{1,4}\s*Return scenarios/im);
  return idx === -1 ? text : text.slice(0, idx);
}

export const p4Suite: Suite = {
  id: "p4",
  title: "VC writing and synthesis",
  repeats: 2,
  roles: ["write"],
  requiredParams: ["temperature"],
  estimatedOutputTokensPerItem: 700,
  usesJudge: true,

  async loadItems(ctx: SuiteContext): Promise<TaskSpec[]> {
    return load(ctx);
  },

  buildRequest(spec: TaskSpec, modelId: string): ProviderRequest {
    return {
      model: modelId,
      system: spec.prompt.system,
      messages: [{ role: "user", content: spec.prompt.user }],
      temperature: spec.requestOverrides?.temperature,
      maxTokens: spec.requestOverrides?.maxTokens,
    };
  },

  async grade(spec: TaskSpec, attempt: Attempt, ctx: GradeContext): Promise<GradeResult> {
    const gold = spec.gold as P4GoldPayload;
    const res = attempt.response;
    const base = {
      attemptId: attempt.attemptId,
      suite: "p4",
      itemId: spec.itemId,
      modelId: attempt.modelId,
    };

    if (!res) return ungraded(spec, attempt, "no response");
    if (res.refusal) {
      return ungraded(spec, attempt, `refusal (${res.refusal.kind}): ${res.refusal.detail}`);
    }

    const output = (res.text ?? "").trim();
    if (output === "") return ungraded(spec, attempt, "empty output");

    const violations: Violation[] = [];
    const evidence: string[] = [];
    const subscores: Record<string, number> = {};

    // --- 1. Structure (memo only) -----------------------------------------
    let structure = 1;
    if (gold.docType === "ic-memo") {
      const missing = IC_MEMO_SECTIONS.filter(
        (s) => !new RegExp(`^#{1,4}\\s*${s.replace(/[&]/g, "\\&")}\\s*$`, "im").test(output),
      );
      structure = (IC_MEMO_SECTIONS.length - missing.length) / IC_MEMO_SECTIONS.length;
      if (missing.length > 0) evidence.push(`missing sections: ${missing.join(", ")}`);
      subscores.sectionsPresent = structure;
    }

    // --- 2. Length cap -----------------------------------------------------
    const cap = LENGTH_CAPS[gold.docType];
    const words = wordCount(output);
    const withinCap = words <= cap;
    subscores.words = words;
    subscores.withinLengthCap = withinCap ? 1 : 0;
    if (!withinCap) evidence.push(`${words} words against a ${cap}-word cap`);

    // --- 3. Number traceability -------------------------------------------
    const checkable = gold.docType === "ic-memo" ? stripReturnScenarios(output) : output;
    const packQuantities = extractNumericTokens(gold.packText);
    const packSet = packQuantities.map((q) => `${q.value}|${q.unit}`);
    const packValues = new Set(packQuantities.map((q) => q.value));
    const untraceable: string[] = [];
    const claims = claimNumbers(checkable);
    for (const c of claims) {
      const exact = packSet.includes(`${c.value}|${c.unit}`);
      // A value present in the pack under a different unit label still traces:
      // the writer may have restated "₹8 crore" as "80 million rupees".
      const loose = packValues.has(c.value);
      if (!exact && !loose) untraceable.push(c.raw);
    }
    const traceability =
      claims.length === 0 ? 1 : (claims.length - untraceable.length) / claims.length;
    subscores.numberTraceability = traceability;
    for (const u of [...new Set(untraceable)]) {
      violations.push({
        kind: "untraceable-number",
        detail: `"${u}" does not appear in the pack`,
        factId: null,
      });
    }
    if (untraceable.length > 0) {
      evidence.push(`untraceable numbers: ${[...new Set(untraceable)].join(", ")}`);
    }

    // --- 4. Delta brief must not re-litigate ------------------------------
    let deltaClean = 1;
    if (gold.docType === "delta-brief") {
      const stale = gold.news.filter((n) => n.previouslyReported);
      const relitigated = stale.filter((n) => mentionsNews(output, n));
      deltaClean = stale.length === 0 ? 1 : (stale.length - relitigated.length) / stale.length;
      for (const r of relitigated) {
        violations.push({
          kind: "relitigated-item",
          detail: `"${r.key}" was already reported to the committee and should not appear in a delta brief`,
          factId: null,
        });
      }
      subscores.deltaClean = deltaClean;
      if (relitigated.length > 0) {
        evidence.push(`re-litigated: ${relitigated.map((r) => r.key).join(", ")}`);
      }
      // It must also actually report the new items.
      const fresh = gold.news.filter((n) => !n.previouslyReported);
      const covered = fresh.filter((n) => mentionsNews(output, n)).length;
      subscores.deltaCoverage = fresh.length === 0 ? 1 : covered / fresh.length;
      evidence.push(`new items covered: ${covered}/${fresh.length}`);
    }

    // --- 5. Judge ----------------------------------------------------------
    let judgeScore: number | null = null;
    let judgeCost = 0;
    let judgeUngradedReason: string | null = null;
    if (ctx.judge) {
      const outcome = await ctx.judge.evaluate({
        itemId: spec.itemId,
        candidateModelId: attempt.modelId,
        candidateFamily: ctx.familyOf(attempt.modelId),
        rubric: P4_RUBRIC,
        sourceMaterial: gold.packText,
        submission: output,
        task: gold.task,
      });
      judgeCost = outcome.costUsd;
      if (outcome.status === "graded") {
        judgeScore = outcome.score;
        evidence.push(...outcome.evidence);
        if (outcome.panelDegraded) evidence.push(`JUDGE PANEL DEGRADED — ${outcome.panelDegraded}`);
        if (outcome.disagreement) {
          subscores.judgeDisagreementPoints = outcome.disagreement.maxPoints;
          if (outcome.disagreement.flagged) {
            evidence.push(
              `JUDGES DISAGREE by ${outcome.disagreement.maxPoints} rubric points — flagged for manual review`,
            );
          }
        }
      } else {
        judgeUngradedReason = outcome.ungradedReason;
        evidence.push(`judge: ${outcome.ungradedReason ?? "no verdict"}`);
      }
    }
    subscores.judgeCostUsd = judgeCost;
    if (judgeScore !== null) subscores.judgeScore = judgeScore;

    // Deterministic half is always available; the judge half only when it ran.
    const deterministic =
      gold.docType === "ic-memo"
        ? (structure + (withinCap ? 1 : 0) + traceability) / 3
        : gold.docType === "delta-brief"
          ? ((withinCap ? 1 : 0) + traceability + deltaClean + (subscores.deltaCoverage ?? 1)) / 4
          : ((withinCap ? 1 : 0) + traceability) / 2;
    subscores.deterministic = deterministic;

    const score = judgeScore === null ? deterministic : (deterministic + judgeScore) / 2;

    return {
      ...base,
      status: "graded",
      ungradedReason: judgeUngradedReason,
      score,
      subscores,
      perTrap: { [gold.docType]: { n: 1, passed: score >= 0.9 ? 1 : 0 } },
      violations,
      evidence,
    };
  },

  aggregate({ attempts, grades }: AggregateInput): SuiteAggregate[] {
    const models = [...new Set(grades.filter((g) => g.suite === "p4").map((g) => g.modelId))];
    const out: SuiteAggregate[] = [];

    for (const modelId of models) {
      const gs = grades.filter((g) => g.suite === "p4" && g.modelId === modelId);
      const as = attempts.filter((a) => a.suite === "p4" && a.modelId === modelId);
      const graded = gs.filter((g) => g.status === "graded" && g.score !== null);
      const metrics: Record<string, number> = {};
      const notes: string[] = [];

      const avg = (k: string) => {
        const v = graded.map((g) => g.subscores[k]).filter((x): x is number => x !== undefined);
        return v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length;
      };

      metrics.score =
        graded.length === 0 ? 0 : graded.reduce((n, g) => n + (g.score ?? 0), 0) / graded.length;
      metrics.deterministic = avg("deterministic");
      metrics.numberTraceability = avg("numberTraceability");
      metrics.withinLengthCap = avg("withinLengthCap");
      metrics.meanWords = avg("words");

      const memo = graded.filter((g) => g.subscores.sectionsPresent !== undefined);
      if (memo.length > 0) {
        metrics.sectionsPresent =
          memo.reduce((n, g) => n + (g.subscores.sectionsPresent ?? 0), 0) / memo.length;
      }
      const delta = graded.filter((g) => g.subscores.deltaClean !== undefined);
      if (delta.length > 0) {
        metrics.deltaClean =
          delta.reduce((n, g) => n + (g.subscores.deltaClean ?? 0), 0) / delta.length;
        metrics.deltaCoverage =
          delta.reduce((n, g) => n + (g.subscores.deltaCoverage ?? 0), 0) / delta.length;
      }
      const judged = graded.filter((g) => g.subscores.judgeScore !== undefined);
      if (judged.length > 0) {
        metrics.judgeScore =
          judged.reduce((n, g) => n + (g.subscores.judgeScore ?? 0), 0) / judged.length;
        metrics.judgedItems = judged.length;
      } else {
        notes.push(
          "no judge verdicts in this run — the score shown is the deterministic half only",
        );
      }

      const degradedPanels = gs.filter((g) =>
        g.evidence.some((e) => e.startsWith("JUDGE PANEL DEGRADED")),
      );
      if (degradedPanels.length > 0) {
        metrics.judgePanelDegraded = degradedPanels.length;
        const why = degradedPanels[0]?.evidence.find((e) => e.startsWith("JUDGE PANEL DEGRADED"));
        notes.push(
          `${degradedPanels.length} item(s) graded by a SHRUNKEN judge panel — ${why ?? ""}`,
        );
      }

      const disagreements = graded
        .map((g) => g.subscores.judgeDisagreementPoints)
        .filter((x): x is number => x !== undefined);
      if (disagreements.length > 0) {
        metrics.judgeDisagreementMean =
          disagreements.reduce((a, b) => a + b, 0) / disagreements.length;
        metrics.judgeDisagreementFlagged = disagreements.filter((d) => d > 2).length;
      }

      metrics.untraceableNumbers = gs.reduce(
        (n, g) => n + g.violations.filter((v) => v.kind === "untraceable-number").length,
        0,
      );
      metrics.relitigated = gs.reduce(
        (n, g) => n + g.violations.filter((v) => v.kind === "relitigated-item").length,
        0,
      );
      metrics.ungraded = gs.filter((g) => g.status !== "graded").length;

      const billed = as.filter((a) => !a.cached);
      const spent = billed.reduce((n, a) => n + a.costUsd, 0);
      const judgeSpend = gs.reduce((n, g) => n + (g.subscores.judgeCostUsd ?? 0), 0);
      metrics.costPer36 = billed.length === 0 ? 0 : (spent / billed.length) * 36;
      metrics.judgeCostUsd = judgeSpend;
      metrics.p95Ms = percentile(
        billed.map((a) => a.response?.latencyMs ?? 0).filter((x) => x > 0),
        95,
      );

      out.push({ suite: "p4", modelId, metrics, cells: {}, notes });
    }
    return out.sort((a, b) => a.modelId.localeCompare(b.modelId));
  },
};
