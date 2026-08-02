import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { LabelSet, P2Gold, P2Item } from "../generators/p2.js";
import { accuracy, labelFlipRate, macroF1, percentile } from "../graders/stats.js";
import type { Attempt, GradeResult, ProviderRequest, TaskSpec, Violation } from "../types.js";
import {
  type AggregateInput,
  type Suite,
  type SuiteAggregate,
  type SuiteContext,
  ungraded,
} from "./types.js";

const STAGES = ["pre-seed", "seed", "series-a", "series-b", "series-c"];
const MEETING_TYPES = ["board-call", "founder-catchup", "internal", "external-other"];
const THESIS_FITS = ["in-thesis", "adjacent", "anti-thesis"];

/**
 * Schemas live in code, not YAML: the grader reads the same constant, so a
 * schema and its grader cannot drift apart.
 */
const SCHEMAS: Record<LabelSet, Record<string, unknown>> = {
  funding: {
    type: "object",
    properties: {
      is_funding_event: { type: "boolean" },
      round_stage: { anyOf: [{ type: "string", enum: STAGES }, { type: "null" }] },
      is_india: { type: "boolean" },
    },
    required: ["is_funding_event", "round_stage", "is_india"],
    additionalProperties: false,
  },
  meeting: {
    type: "object",
    properties: { meeting_type: { type: "string", enum: MEETING_TYPES } },
    required: ["meeting_type"],
    additionalProperties: false,
  },
  signal: {
    type: "object",
    properties: { classification: { type: "string", enum: ["signal", "noise"] } },
    required: ["classification"],
    additionalProperties: false,
  },
  thesis: {
    type: "object",
    properties: { fit: { type: "string", enum: THESIS_FITS } },
    required: ["fit"],
    additionalProperties: false,
  },
};

const FIELDS: Record<LabelSet, string[]> = {
  funding: ["is_funding_event", "round_stage", "is_india"],
  meeting: ["meeting_type"],
  signal: ["classification"],
  thesis: ["fit"],
};

interface TaskFile {
  id: string;
  title: string;
  repeats: number;
  estimatedOutputTokensPerItem: number;
  system: string;
  labelSets: Record<LabelSet, { instruction: string }>;
}

interface P2GoldPayload {
  labelSet: LabelSet;
  labels: Record<string, string | boolean | null>;
  trapType: string;
  note: string;
}

let cached: { specs: TaskSpec[]; task: TaskFile } | null = null;

function load(ctx: SuiteContext): { specs: TaskSpec[]; task: TaskFile } {
  if (cached) return cached;
  const dir = join(ctx.root, "suites", "p2-classification");
  const task = parseYaml(readFileSync(join(dir, "task.yaml"), "utf8")) as TaskFile;
  const fixtures = JSON.parse(readFileSync(join(dir, "fixtures", "items.json"), "utf8")) as {
    watchlist: string[];
    thesis: string;
    items: P2Item[];
  };
  const goldFile = JSON.parse(readFileSync(join(dir, "gold", "gold.json"), "utf8")) as {
    gold: P2Gold[];
  };
  const goldById = new Map(goldFile.gold.map((g) => [g.id, g]));

  const specs: TaskSpec[] = fixtures.items.map((item) => {
    const gold = goldById.get(item.id);
    if (!gold) throw new Error(`p2: item ${item.id} has no gold row`);
    const instruction = task.labelSets[item.labelSet].instruction
      .replace("{{watchlist}}", fixtures.watchlist.map((w) => `- ${w}`).join("\n"))
      .replace("{{thesis}}", fixtures.thesis);
    return {
      suite: "p2",
      itemId: item.id,
      fixtureVersion: ctx.fixturesVersion,
      prompt: {
        system: task.system,
        user: `${instruction.trim()}\n\n---\n${item.text}`,
      },
      jsonSchema: SCHEMAS[item.labelSet],
      requestOverrides: { temperature: 0, maxTokens: 200 },
      gold: {
        labelSet: item.labelSet,
        labels: gold.labels,
        trapType: item.trapType,
        note: item.note,
      } satisfies P2GoldPayload,
      weight: 1,
    };
  });

  // --smoke: keep at least one item from every label set rather than the first N,
  // which would only ever exercise `funding`.
  const limited = ctx.maxItems === null ? specs : takeAcrossLabelSets(specs, ctx.maxItems);
  cached = { specs: limited, task };
  return cached;
}

function takeAcrossLabelSets(specs: TaskSpec[], perSet: number): TaskSpec[] {
  const seen: Record<string, number> = {};
  return specs.filter((s) => {
    const ls = (s.gold as P2GoldPayload).labelSet;
    seen[ls] = (seen[ls] ?? 0) + 1;
    return seen[ls] <= perSet;
  });
}

function normaliseStage(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase().replace(/\s+/g, "-");
  if (s === "" || s === "null" || s === "n/a" || s === "unknown" || s === "undisclosed")
    return null;
  const compact = s.replace(/^series\s*-?/, "series-");
  return STAGES.includes(compact) ? compact : s;
}

export const p2Suite: Suite = {
  id: "p2",
  title: "Classification at volume",
  repeats: 2,
  roles: ["classify"],
  requiredParams: ["temperature", "jsonSchema"],
  estimatedOutputTokensPerItem: 40,
  usesJudge: false,

  async loadItems(ctx: SuiteContext): Promise<TaskSpec[]> {
    return load(ctx).specs;
  },

  buildRequest(spec: TaskSpec, modelId: string): ProviderRequest {
    return {
      model: modelId,
      system: spec.prompt.system,
      messages: [{ role: "user", content: spec.prompt.user }],
      jsonSchema: spec.jsonSchema,
      temperature: spec.requestOverrides?.temperature,
      maxTokens: spec.requestOverrides?.maxTokens,
    };
  },

  async grade(spec: TaskSpec, attempt: Attempt): Promise<GradeResult> {
    const res = attempt.response;
    const gold = spec.gold as P2GoldPayload;
    const base = {
      attemptId: attempt.attemptId,
      suite: "p2",
      itemId: spec.itemId,
      modelId: attempt.modelId,
    };

    if (!res) return ungraded(spec, attempt, "no response");
    if (res.refusal) {
      return ungraded(spec, attempt, `refusal (${res.refusal.kind}): ${res.refusal.detail}`);
    }

    const json = res.json as Record<string, unknown> | undefined;
    const fields = FIELDS[gold.labelSet];

    if (!json || typeof json !== "object") {
      return {
        ...base,
        status: "graded",
        ungradedReason: null,
        score: 0,
        subscores: { schemaValid: 0 },
        perTrap: { [gold.trapType]: { n: 1, passed: 0 } },
        violations: [
          {
            kind: "schema-invalid",
            detail: `no parseable JSON object; raw: ${(res.text ?? "").slice(0, 200)}`,
            factId: null,
          },
        ],
        evidence: [(res.text ?? "").slice(0, 300)],
      };
    }

    const violations: Violation[] = [];
    let correct = 0;

    for (const field of fields) {
      const want = gold.labels[field];
      let got = json[field];
      if (field === "round_stage") got = normaliseStage(got);
      if (got === want) correct++;
    }

    // Asserting a round stage on something the model itself called a non-event
    // is an invented value, not merely a wrong label.
    if (gold.labelSet === "funding") {
      const stage = normaliseStage(json.round_stage);
      if (json.is_funding_event === false && stage !== null) {
        violations.push({
          kind: "invented-value",
          detail: `model said is_funding_event=false but still returned round_stage="${String(json.round_stage)}"`,
          factId: null,
        });
      }
      if (
        gold.labels.round_stage === null &&
        gold.labels.is_funding_event === true &&
        stage !== null
      ) {
        violations.push({
          kind: "invented-value",
          detail: `stage was never stated in the source; model returned "${String(json.round_stage)}"`,
          factId: null,
        });
      }
    }

    const score = correct / fields.length;
    const allCorrect = correct === fields.length;

    return {
      ...base,
      status: "graded",
      ungradedReason: null,
      score,
      subscores: {
        schemaValid: 1,
        exactMatch: allCorrect ? 1 : 0,
        fieldsCorrect: correct,
        fieldsTotal: fields.length,
      },
      perTrap: { [gold.trapType]: { n: 1, passed: allCorrect ? 1 : 0 } },
      violations,
      evidence: [
        `gold=${JSON.stringify(gold.labels)}`,
        `pred=${JSON.stringify(Object.fromEntries(fields.map((f) => [f, json[f] ?? null])))}`,
        `trap=${gold.trapType} (${gold.note})`,
      ],
    };
  },

  aggregate({ specs, attempts, grades }: AggregateInput): SuiteAggregate[] {
    const specById = new Map(specs.map((s) => [s.itemId, s]));
    const attemptById = new Map(attempts.map((a) => [a.attemptId, a]));
    const byModel = new Map<string, GradeResult[]>();
    for (const g of grades) {
      if (g.suite !== "p2") continue;
      const list = byModel.get(g.modelId) ?? [];
      list.push(g);
      byModel.set(g.modelId, list);
    }

    const out: SuiteAggregate[] = [];
    for (const [modelId, gs] of byModel) {
      const metrics: Record<string, number> = {};
      const notes: string[] = [];

      // Per-label-set accuracy and macro-F1 on the single discriminative field.
      for (const ls of ["funding", "meeting", "signal", "thesis"] as LabelSet[]) {
        const rows = gs.filter(
          (g) => (specById.get(g.itemId)?.gold as P2GoldPayload)?.labelSet === ls,
        );
        const graded = rows.filter((g) => g.status === "graded");
        if (graded.length === 0) continue;

        metrics[`${ls}.accuracy`] =
          graded.filter((g) => g.subscores.exactMatch === 1).length / graded.length;

        const key = ls === "funding" ? "round_stage" : FIELDS[ls][0]!;
        const pairs = graded.map((g) => {
          const gold = specById.get(g.itemId)?.gold as P2GoldPayload;
          const pred = parsePred(attemptById.get(g.attemptId), key);
          return { gold: String(gold.labels[key]), pred: pred === null ? "<null>" : String(pred) };
        });
        metrics[`${ls}.macroF1`] = macroF1(
          pairs.map((p) => ({ gold: p.gold === "null" ? "<null>" : p.gold, pred: p.pred })),
        );
      }

      const graded = gs.filter((g) => g.status === "graded");
      metrics.accuracy = accuracy(
        graded.map((g) => ({ gold: 1, pred: g.subscores.exactMatch === 1 ? 1 : 0 })),
      );
      metrics.schemaValidRate =
        graded.length === 0
          ? 0
          : graded.filter((g) => g.subscores.schemaValid === 1).length / graded.length;
      metrics.ungraded = gs.filter((g) => g.status !== "graded").length;
      metrics.inventedValues = gs.reduce(
        (n, g) => n + g.violations.filter((v) => v.kind === "invented-value").length,
        0,
      );

      // Label-flip across repeats: identical call, different answer.
      const byItem = new Map<string, string[]>();
      for (const g of gs) {
        const a = attemptById.get(g.attemptId);
        if (!a?.response?.json) continue;
        const spec = specById.get(g.itemId);
        if (!spec) continue;
        const ls = (spec.gold as P2GoldPayload).labelSet;
        const sig = FIELDS[ls]
          .map((f) => String((a.response?.json as Record<string, unknown>)[f] ?? "null"))
          .join("|");
        const list = byItem.get(g.itemId) ?? [];
        list.push(sig);
        byItem.set(g.itemId, list);
      }
      metrics.labelFlipRate = labelFlipRate(byItem);

      // Cost per 1,000 classifications — the number that actually decides this suite.
      const modelAttempts = attempts.filter((a) => a.modelId === modelId && a.suite === "p2");
      const billed = modelAttempts.filter((a) => !a.cached);
      const spent = billed.reduce((n, a) => n + a.costUsd, 0);
      metrics.costPer1k = billed.length === 0 ? 0 : (spent / billed.length) * 1000;
      if (billed.length === 0) {
        notes.push("all attempts served from cache; cost per 1k is from a prior run, not this one");
      }

      const lat = billed.map((a) => a.response?.latencyMs ?? 0).filter((x) => x > 0);
      metrics.p50Ms = percentile(lat, 50);
      metrics.p95Ms = percentile(lat, 95);

      const dropped = [...new Set(modelAttempts.flatMap((a) => a.response?.paramsDropped ?? []))];
      if (dropped.includes("temperature")) {
        notes.push(
          "temperature was rejected by this model; label-flip rate is measured at provider default, not at temp 0",
        );
      }

      out.push({ suite: "p2", modelId, metrics, cells: {}, notes });
    }
    return out.sort((a, b) => a.modelId.localeCompare(b.modelId));
  },
};

function parsePred(attempt: Attempt | undefined, key: string): unknown {
  const json = attempt?.response?.json as Record<string, unknown> | undefined;
  if (!json) return null;
  const v = json[key];
  return key === "round_stage" ? normaliseStage(v) : (v ?? null);
}
