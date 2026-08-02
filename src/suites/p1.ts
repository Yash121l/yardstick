import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { P1Fact } from "../generators/p1.js";
import { compareQuantity, normalizeQuantity } from "../graders/normalize.js";
import { checkProvenance } from "../graders/provenance.js";
import { percentile } from "../graders/stats.js";
import { stableStringify } from "../runner/cache.js";
import type { Attempt, GradeResult, ProviderRequest, TaskSpec, Violation } from "../types.js";
import {
  type AggregateInput,
  type Suite,
  type SuiteAggregate,
  type SuiteContext,
  ungraded,
} from "./types.js";

const SCHEMA = {
  type: "object",
  properties: {
    metrics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string" },
          value: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
          unit: { anyOf: [{ type: "string" }, { type: "null" }] },
          quote: { anyOf: [{ type: "string" }, { type: "null" }] },
          confidence: { type: "number" },
        },
        required: ["field", "value", "unit", "quote", "confidence"],
        additionalProperties: false,
      },
    },
    signals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string" },
          value: { anyOf: [{ type: "string" }, { type: "null" }] },
          quote: { anyOf: [{ type: "string" }, { type: "null" }] },
          confidence: { type: "number" },
        },
        required: ["field", "value", "quote", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["metrics", "signals"],
  additionalProperties: false,
} as const;

interface TaskFile {
  repeats: number;
  estimatedOutputTokensPerItem: number;
  system: string;
  instruction: string;
}

interface P1GoldPayload {
  facts: P1Fact[];
  transcript: string;
  requestedFields: string[];
}

interface Extracted {
  field: string;
  value: unknown;
  unit: unknown;
  quote: unknown;
}

let cached: TaskSpec[] | null = null;

function load(ctx: SuiteContext): TaskSpec[] {
  if (cached) return cached;
  const dir = join(ctx.root, "suites", "p1-extraction");
  const task = parseYaml(readFileSync(join(dir, "task.yaml"), "utf8")) as TaskFile;
  const fx = JSON.parse(readFileSync(join(dir, "fixtures", "transcripts.json"), "utf8")) as {
    transcripts: { id: string; text: string; requestedFields: string[] }[];
  };
  const gold = JSON.parse(readFileSync(join(dir, "gold", "facts.json"), "utf8")) as {
    gold: { id: string; facts: P1Fact[] }[];
  };
  const goldById = new Map(gold.gold.map((g) => [g.id, g.facts]));

  const specs = fx.transcripts.map((t): TaskSpec => {
    const facts = goldById.get(t.id);
    if (!facts) throw new Error(`p1: transcript ${t.id} has no gold`);
    const metricFields = facts.filter((f) => f.kind === "metric").map((f) => f.field);
    const signalFields = facts.filter((f) => f.kind === "signal").map((f) => f.field);
    const instruction = task.instruction
      .replace("{{metricFields}}", metricFields.map((f) => `  - ${f}`).join("\n"))
      .replace("{{signalFields}}", signalFields.map((f) => `  - ${f}`).join("\n"));
    return {
      suite: "p1",
      itemId: t.id,
      fixtureVersion: ctx.fixturesVersion,
      prompt: {
        system: task.system,
        user: `${instruction.trim()}\n\n--- TRANSCRIPT ---\n${t.text}`,
      },
      jsonSchema: SCHEMA as unknown as Record<string, unknown>,
      requestOverrides: { temperature: 0, maxTokens: 4000 },
      gold: {
        facts,
        transcript: t.text,
        requestedFields: t.requestedFields,
      } satisfies P1GoldPayload,
      weight: 1,
    };
  });

  cached = ctx.maxItems === null ? specs : specs.slice(0, ctx.maxItems);
  return cached;
}

function collect(json: unknown): { metrics: Extracted[]; signals: Extracted[] } | null {
  if (!json || typeof json !== "object") return null;
  const o = json as { metrics?: unknown; signals?: unknown };
  if (!Array.isArray(o.metrics) || !Array.isArray(o.signals)) return null;
  const norm = (arr: unknown[]): Extracted[] =>
    arr
      .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
      .map((x) => ({
        field: String(x.field ?? "")
          .trim()
          .toLowerCase(),
        value: x.value ?? null,
        unit: x.unit ?? null,
        quote: x.quote ?? null,
      }));
  return { metrics: norm(o.metrics), signals: norm(o.signals) };
}

/** Canonical form for the semantic-determinism comparison. */
function semanticForm(json: unknown): string {
  const c = collect(json);
  if (!c) return "<invalid>";
  const rows = [...c.metrics, ...c.signals]
    .map((e) => {
      const q = normalizeQuantity(e.value, e.unit);
      const v =
        q.value !== null
          ? `${q.value}|${q.unit}`
          : String(e.value ?? "null")
              .trim()
              .toLowerCase();
      return `${e.field}=${v}`;
    })
    .sort();
  return rows.join(";");
}

export const p1Suite: Suite = {
  id: "p1",
  title: "Structured extraction with provenance",
  repeats: 3,
  roles: ["extract"],
  requiredParams: ["temperature", "jsonSchema"],
  estimatedOutputTokensPerItem: 900,
  usesJudge: false,

  async loadItems(ctx: SuiteContext): Promise<TaskSpec[]> {
    return load(ctx);
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
    const gold = spec.gold as P1GoldPayload;
    const res = attempt.response;
    const base = {
      attemptId: attempt.attemptId,
      suite: "p1",
      itemId: spec.itemId,
      modelId: attempt.modelId,
    };

    if (!res) return ungraded(spec, attempt, "no response");
    if (res.refusal) {
      return ungraded(spec, attempt, `refusal (${res.refusal.kind}): ${res.refusal.detail}`);
    }

    const parsed = collect(res.json);
    if (!parsed) {
      // Schema validity is a hard gate: nothing else is meaningful without it.
      return {
        ...base,
        status: "graded",
        ungradedReason: null,
        score: 0,
        subscores: { schemaValid: 0 },
        perTrap: {},
        violations: [
          {
            kind: "schema-invalid",
            detail: `expected {metrics:[],signals:[]}; got ${JSON.stringify(res.json ?? res.text)?.slice(0, 200)}`,
            factId: null,
          },
        ],
        evidence: [(res.text ?? "").slice(0, 300)],
      };
    }

    const byField = new Map<string, Extracted>();
    for (const e of [...parsed.metrics, ...parsed.signals]) {
      if (!byField.has(e.field)) byField.set(e.field, e);
    }

    const violations: Violation[] = [];
    const evidence: string[] = [];
    const perTrap: Record<string, { n: number; passed: number }> = {};
    const bump = (trap: string, passed: boolean) => {
      const t = perTrap[trap] ?? { n: 0, passed: 0 };
      t.n++;
      if (passed) t.passed++;
      perTrap[trap] = t;
    };

    const present = gold.facts.filter((f) => f.trapType !== "absent");
    const absent = gold.facts.filter((f) => f.trapType === "absent");

    let hits = 0;
    let quotesSupplied = 0;
    let quotesVerbatim = 0;
    let unitTrapTotal = 0;
    let unitTrapOk = 0;

    for (const fact of present) {
      const got = byField.get(fact.field);
      if (!got || got.value === null || got.value === undefined) {
        bump(fact.trapType, false);
        evidence.push(`${fact.field}: MISS (not reported)`);
        continue;
      }

      // Value comparison, canonicalised so crore/lakh/$M and % vs pp behave.
      let valueOk: boolean;
      let unitOk = true;
      if (fact.kind === "metric") {
        const wantQ = {
          value: fact.canonical.value,
          unit: (fact.canonical.unit ?? "unknown") as never,
        };
        const gotQ = normalizeQuantity(got.value, got.unit);
        const cmp = compareQuantity(gotQ, wantQ, { allowUnknownUnit: false });
        valueOk = cmp.valueMatches;
        unitOk = cmp.unitMatches;
        if (fact.trapType === "unit-trap") {
          unitTrapTotal++;
          if (cmp.match) unitTrapOk++;
        }
      } else {
        // Signals are free text; require the key entity to appear.
        const want = String(fact.value ?? "").toLowerCase();
        const gotText = String(got.value ?? "").toLowerCase();
        const key = want.split(/[\s(]+/).filter((w) => w.length > 3)[0] ?? want;
        valueOk = gotText.includes(key);
      }

      const prov = checkProvenance({
        quote: got.quote,
        source: gold.transcript,
        plantedQuote: fact.quote,
      });
      if (typeof got.quote === "string" && got.quote.trim() !== "") quotesSupplied++;
      if (prov.ok) quotesVerbatim++;

      // Provenance or it didn't happen: a right value with a bad citation is a
      // miss, and a fabricated quote is logged as its own violation.
      const hit = valueOk && unitOk && prov.ok;
      if (hit) hits++;
      bump(fact.trapType, hit);

      if (!prov.ok) {
        violations.push({
          kind: "fabricated-quote",
          detail: `${fact.field}: ${prov.failure} — ${prov.detail}`,
          factId: fact.id,
        });
      }
      evidence.push(
        `${fact.field}: value=${valueOk ? "ok" : "WRONG"} unit=${unitOk ? "ok" : "WRONG"} ` +
          `quote=${prov.ok ? "verbatim" : (prov.failure ?? "bad")}` +
          (prov.nearMiss ? ` (near-miss: ${prov.nearMiss})` : "") +
          ` | got=${JSON.stringify(got.value)} ${String(got.unit ?? "")}`,
      );
    }

    let honestNulls = 0;
    for (const fact of absent) {
      const got = byField.get(fact.field);
      const reportedSomething =
        got !== undefined &&
        got.value !== null &&
        got.value !== undefined &&
        String(got.value).trim() !== "";
      if (!reportedSomething) {
        honestNulls++;
        bump("absent", true);
        evidence.push(`${fact.field}: honest null`);
      } else {
        bump("absent", false);
        violations.push({
          kind: "invented-value",
          detail: `${fact.field} is not stated anywhere in the transcript; model returned ${JSON.stringify(got.value)}`,
          factId: fact.id,
        });
        evidence.push(`${fact.field}: INVENTED ${JSON.stringify(got.value)}`);
      }
    }

    // Spurious fields the model volunteered that were never requested.
    const requested = new Set(gold.requestedFields);
    const spurious = [...byField.keys()].filter((f) => !requested.has(f));

    const nonNullReported = [...byField.entries()].filter(
      ([, e]) => e.value !== null && e.value !== undefined && String(e.value).trim() !== "",
    ).length;

    // Inventing a value on an absent field costs 3x a plain miss.
    const weightedTotal = present.length + 3 * absent.length;
    const weightedCorrect = hits + 3 * honestNulls;
    const score = weightedTotal === 0 ? 0 : weightedCorrect / weightedTotal;

    return {
      ...base,
      status: "graded",
      ungradedReason: null,
      score,
      subscores: {
        schemaValid: 1,
        recall: present.length === 0 ? 0 : hits / present.length,
        precision: nonNullReported === 0 ? 0 : hits / nonNullReported,
        provenance: quotesSupplied === 0 ? 0 : quotesVerbatim / quotesSupplied,
        honestNull: absent.length === 0 ? 1 : honestNulls / absent.length,
        unitAccuracy: unitTrapTotal === 0 ? 1 : unitTrapOk / unitTrapTotal,
        spuriousFields: spurious.length,
      },
      perTrap,
      violations,
      evidence,
    };
  },

  aggregate({ attempts, grades }: AggregateInput): SuiteAggregate[] {
    const byModel = new Map<string, string[]>();
    for (const g of grades) if (g.suite === "p1") byModel.set(g.modelId, []);

    const out: SuiteAggregate[] = [];
    for (const modelId of byModel.keys()) {
      const gs = grades.filter((g) => g.suite === "p1" && g.modelId === modelId);
      const as = attempts.filter((a) => a.suite === "p1" && a.modelId === modelId);
      const graded = gs.filter((g) => g.status === "graded" && g.score !== null);
      const metrics: Record<string, number> = {};
      const notes: string[] = [];

      const avg = (key: string) => {
        const vals = graded
          .map((g) => g.subscores[key])
          .filter((v): v is number => v !== undefined);
        return vals.length === 0 ? 0 : vals.reduce((a, b) => a + b, 0) / vals.length;
      };

      metrics.score =
        graded.length === 0 ? 0 : graded.reduce((n, g) => n + (g.score ?? 0), 0) / graded.length;
      metrics.recall = avg("recall");
      metrics.precision = avg("precision");
      metrics.provenance = avg("provenance");
      metrics.honestNull = avg("honestNull");
      metrics.unitAccuracy = avg("unitAccuracy");

      // Hallucination Index: invented values per 100 items. Kept separate from
      // the score on purpose — a model that is 95% right and invents the rest
      // is unusable for extraction, and an average would hide that.
      const invented = gs.reduce(
        (n, g) => n + g.violations.filter((v) => v.kind === "invented-value").length,
        0,
      );
      const fabricated = gs.reduce(
        (n, g) => n + g.violations.filter((v) => v.kind === "fabricated-quote").length,
        0,
      );
      metrics.hallucinationPer100 = gs.length === 0 ? 0 : (invented / gs.length) * 100;
      metrics.fabricatedQuotesPer100 = gs.length === 0 ? 0 : (fabricated / gs.length) * 100;
      metrics.ungraded = gs.filter((g) => g.status !== "graded").length;

      // Determinism across the repeats of each item.
      const byItem = new Map<string, Attempt[]>();
      for (const a of as) {
        const list = byItem.get(a.itemId) ?? [];
        list.push(a);
        byItem.set(a.itemId, list);
      }
      let exact = 0;
      let semantic = 0;
      let comparable = 0;
      for (const list of byItem.values()) {
        const withJson = list.filter((a) => a.response?.json !== undefined);
        if (withJson.length < 2) continue;
        comparable++;
        const exactForms = new Set(withJson.map((a) => stableStringify(a.response?.json)));
        const semForms = new Set(withJson.map((a) => semanticForm(a.response?.json)));
        if (exactForms.size === 1) exact++;
        if (semForms.size === 1) semantic++;
      }
      if (comparable > 0) {
        metrics.exactJsonMatch = exact / comparable;
        metrics.semanticMatch = semantic / comparable;
      } else {
        notes.push("determinism omitted: fewer than 2 comparable repeats per item");
      }

      const billed = as.filter((a) => !a.cached);
      const spent = billed.reduce((n, a) => n + a.costUsd, 0);
      metrics.costPer25 = billed.length === 0 ? 0 : (spent / billed.length) * 25;
      if (billed.length === 0) {
        notes.push("every attempt was served from cache; cost per 25 is 0 for this run, not free");
      }
      metrics.p95Ms = percentile(
        billed.map((a) => a.response?.latencyMs ?? 0).filter((x) => x > 0),
        95,
      );

      const dropped = [...new Set(as.flatMap((a) => a.response?.paramsDropped ?? []))];
      if (dropped.includes("temperature")) {
        notes.push(
          "temperature was rejected; determinism here is measured at provider default, not at temp 0",
        );
      }

      out.push({ suite: "p1", modelId, metrics, cells: {}, notes });
    }
    return out.sort((a, b) => a.modelId.localeCompare(b.modelId));
  },
};
