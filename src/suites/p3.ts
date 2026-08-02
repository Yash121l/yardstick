import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type SqlResult,
  Warehouse,
  checkStatement,
  demandsOrder,
  resultsEquivalent,
} from "../graders/sql-exec.js";
import { percentile } from "../graders/stats.js";
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
    sql: { type: "string" },
    answer: { type: "string" },
  },
  required: ["sql", "answer"],
  additionalProperties: false,
} as const;

interface P3GoldPayload {
  goldSql: string;
  expectEmpty: boolean;
  trap: string;
  note: string;
  question: string;
}

/** Phrases that count as honestly reporting an empty result. */
const NO_DATA = [
  /\bno\s+(data|rows|results?|records?|matches|companies|funds|entries|such)\b/i,
  /\bnone\b/i,
  /\bnothing\b/i,
  /\bzero\s+(rows|results?|companies|records?)\b/i,
  /\bempty\b/i,
  /\bdid\s+not\s+(find|return|match)\b/i,
  /\bthere\s+are\s+no\b/i,
  /\bno\s+companies\s+(meet|match|have)\b/i,
];

let specsCache: TaskSpec[] | null = null;
let warehouse: Warehouse | null = null;
let dbPath = "";
/** Gold result sets, executed once and reused across every attempt. */
const goldCache = new Map<string, SqlResult>();
/** DuckDB connections are not safe to drive concurrently; serialise. */
let queue: Promise<unknown> = Promise.resolve();

function serialise<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

async function db(): Promise<Warehouse> {
  if (!warehouse) warehouse = await Warehouse.openReadOnly(dbPath);
  return warehouse;
}

function load(ctx: SuiteContext): TaskSpec[] {
  if (specsCache) return specsCache;
  const dir = join(ctx.root, "suites", "p3-sql");
  dbPath = join(dir, "fixtures", "warehouse.duckdb");
  const fx = JSON.parse(readFileSync(join(dir, "fixtures", "questions.json"), "utf8")) as {
    schemaCard: string;
    questions: { id: string; question: string; expectEmpty: boolean; trap: string; note: string }[];
  };
  const gold = JSON.parse(readFileSync(join(dir, "gold", "queries.json"), "utf8")) as {
    gold: { id: string; goldSql: string; expectEmpty: boolean }[];
  };
  const goldById = new Map(gold.gold.map((g) => [g.id, g]));

  const specs = fx.questions.map((q): TaskSpec => {
    const g = goldById.get(q.id);
    if (!g) throw new Error(`p3: question ${q.id} has no gold SQL`);
    return {
      suite: "p3",
      itemId: q.id,
      fixtureVersion: ctx.fixturesVersion,
      prompt: {
        system:
          "You translate questions into DuckDB SQL. You return only JSON matching the schema. " +
          "Write a single read-only SELECT statement. " +
          "If the query would return no rows, say so plainly in your answer rather than describing rows that do not exist.",
        user: `${fx.schemaCard}\n\n--- QUESTION ---\n${q.question}\n\nReturn the SQL and a one-sentence plain answer describing what the query returns.`,
      },
      jsonSchema: SCHEMA as unknown as Record<string, unknown>,
      requestOverrides: { temperature: 0, maxTokens: 1200 },
      gold: {
        goldSql: g.goldSql,
        expectEmpty: q.expectEmpty,
        trap: q.trap,
        note: q.note,
        question: q.question,
      } satisfies P3GoldPayload,
      weight: 1,
    };
  });

  specsCache = ctx.maxItems === null ? specs : specs.slice(0, ctx.maxItems);
  return specsCache;
}

/** Flags a bare table reference where the schema card demanded qualification. */
export function unqualifiedTables(sql: string): string[] {
  const cleaned = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''");
  const bad: string[] = [];
  // CTE names are legitimately unqualified; collect and exempt them.
  const ctes = new Set<string>();
  for (const m of cleaned.matchAll(/\b(?:with|,)\s+([A-Za-z_][\w]*)\s+as\s*\(/gi)) {
    if (m[1]) ctes.add(m[1].toLowerCase());
  }
  for (const m of cleaned.matchAll(/\b(?:from|join)\s+([A-Za-z_][\w.]*)/gi)) {
    const ref = m[1];
    if (!ref) continue;
    if (ref.includes(".")) continue;
    if (ctes.has(ref.toLowerCase())) continue;
    // EXTRACT(YEAR FROM col), SUBSTRING(s FROM 1), TRIM(x FROM y): the word
    // FROM here introduces a column or a literal, not a table. Flagging those
    // would report a qualification failure that never happened.
    const before = cleaned.slice(Math.max(0, m.index - 40), m.index);
    if (/(extract|substring|trim|position|overlay)\s*\([^)]*$/i.test(before)) continue;
    bad.push(ref);
  }
  return [...new Set(bad)];
}

/**
 * Does the prose claim a specific, non-empty result?
 *
 * A number the question itself did not contain, or an explicit "the following
 * are...", means the model has asserted rows it never saw. A description of
 * what the query does contains neither.
 */
function assertsConcreteRows(prose: string, question: string): boolean {
  const fromQuestion = new Set(question.match(/\d+/g) ?? []);
  const invented = (prose.match(/\d+/g) ?? []).filter(
    (n) => !fromQuestion.has(n) && Number.parseInt(n, 10) > 0,
  );
  if (invented.length > 0) return true;
  return /\bthe following\b|\bthese (companies|funds|rows)\b|\bnamely\b/i.test(prose);
}

export const p3Suite: Suite = {
  id: "p3",
  title: "NL to SQL, execution-graded",
  repeats: 3,
  roles: ["sql"],
  requiredParams: ["temperature", "jsonSchema"],
  estimatedOutputTokensPerItem: 220,
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
    const gold = spec.gold as P3GoldPayload;
    const res = attempt.response;
    const base = {
      attemptId: attempt.attemptId,
      suite: "p3",
      itemId: spec.itemId,
      modelId: attempt.modelId,
      status: "graded" as const,
      ungradedReason: null,
      perTrap: { [gold.trap]: { n: 1, passed: 0 } },
    };

    if (!res) return ungraded(spec, attempt, "no response");
    if (res.refusal) {
      return ungraded(spec, attempt, `refusal (${res.refusal.kind}): ${res.refusal.detail}`);
    }

    const json = res.json as { sql?: unknown; answer?: unknown } | undefined;
    const sql = typeof json?.sql === "string" ? json.sql : "";
    const prose = typeof json?.answer === "string" ? json.answer : "";
    const violations: Violation[] = [];
    const evidence: string[] = [`sql: ${sql.slice(0, 400)}`, `answer: ${prose.slice(0, 240)}`];

    if (sql === "") {
      return {
        ...base,
        score: 0,
        subscores: { schemaValid: 0 },
        violations: [
          { kind: "schema-invalid", detail: "no sql field in the response", factId: null },
        ],
        evidence,
      };
    }

    // Any non-SELECT is an automatic zero, checked before execution.
    const check = checkStatement(sql);
    if (!check.ok && (check.kind === "non-select" || check.kind === "multiple-statements")) {
      violations.push({ kind: "non-select-sql", detail: check.detail, factId: null });
      return {
        ...base,
        score: 0,
        subscores: { schemaValid: 1, executed: 0, nonSelect: 1 },
        violations,
        evidence,
      };
    }

    const wh = await db();
    const got = await serialise(() => wh.runChecked(sql));

    let goldResult = goldCache.get(spec.itemId);
    if (!goldResult) {
      const g = await serialise(() => wh.runChecked(gold.goldSql));
      if (!g.ok) {
        // The fixture is broken, not the model. Never score the model for this.
        return ungraded(spec, attempt, `gold SQL failed to execute: ${g.detail}`);
      }
      goldResult = g;
      goldCache.set(spec.itemId, g);
    }

    if (!got.ok) {
      evidence.push(`execution failed: ${got.detail}`);
      return {
        ...base,
        score: 0,
        subscores: { schemaValid: 1, executed: 0 },
        violations,
        evidence,
      };
    }

    const ordered = demandsOrder(gold.goldSql);
    const eq = resultsEquivalent(got, goldResult, { ordered });
    evidence.push(`rows: got ${eq.gotRows}, gold ${eq.goldRows} — ${eq.reason}`);

    // Dialect trap: SIMILAR TO with regex metacharacters silently returns zero
    // rows in DuckDB, so the query "works" and quietly answers nothing.
    const usedSimilarTo = /\bsimilar\s+to\b/i.test(sql);
    if (usedSimilarTo) {
      evidence.push("used SIMILAR TO, which must match the whole string in DuckDB");
    }

    // Fully-qualified names were demanded by the schema card.
    const bare = unqualifiedTables(sql);
    if (bare.length > 0) {
      evidence.push(`unqualified table reference(s): ${bare.join(", ")}`);
    }

    // Honesty on a genuinely-empty answer.
    //
    // This suite is single-turn: the model writes its prose WITHOUT ever seeing
    // the query result, so it cannot know the answer is empty. Demanding the
    // phrase "no data" would test clairvoyance, not honesty. What is fair to
    // demand is that it does not INVENT a concrete result — a neutral
    // description of what the query returns is an honest answer here.
    // (`saysNoData` is still recorded, so the stronger property stays visible.)
    let emptyHonest = true;
    let saysNoData = false;
    if (gold.expectEmpty) {
      saysNoData = NO_DATA.some((re) => re.test(prose));
      const invented = assertsConcreteRows(prose, gold.question);
      emptyHonest = saysNoData || !invented;
      if (!emptyHonest) {
        violations.push({
          kind: "invented-value",
          detail: `the correct answer is zero rows, but the prose asserts a concrete result: ${prose.slice(0, 160)}`,
          factId: null,
        });
      }
    }

    const correct = eq.equal && emptyHonest;
    const score = correct ? 1 : 0;

    return {
      ...base,
      score,
      subscores: {
        schemaValid: 1,
        executed: 1,
        resultMatch: eq.equal ? 1 : 0,
        emptyHonest: gold.expectEmpty ? (emptyHonest ? 1 : 0) : 1,
        saysNoData: gold.expectEmpty ? (saysNoData ? 1 : 0) : 1,
        qualifiedNames: bare.length === 0 ? 1 : 0,
        usedSimilarTo: usedSimilarTo ? 1 : 0,
      },
      perTrap: { [gold.trap]: { n: 1, passed: correct ? 1 : 0 } },
      violations,
      evidence,
    };
  },

  aggregate({ attempts, grades }: AggregateInput): SuiteAggregate[] {
    const models = [...new Set(grades.filter((g) => g.suite === "p3").map((g) => g.modelId))];
    const out: SuiteAggregate[] = [];

    for (const modelId of models) {
      const gs = grades.filter((g) => g.suite === "p3" && g.modelId === modelId);
      const as = attempts.filter((a) => a.suite === "p3" && a.modelId === modelId);
      const graded = gs.filter((g) => g.status === "graded");
      const metrics: Record<string, number> = {};
      const notes: string[] = [];

      const rate = (key: string) => {
        const vals = graded
          .map((g) => g.subscores[key])
          .filter((v): v is number => v !== undefined);
        return vals.length === 0 ? 0 : vals.reduce((a, b) => a + b, 0) / vals.length;
      };

      metrics.score =
        graded.length === 0 ? 0 : graded.reduce((n, g) => n + (g.score ?? 0), 0) / graded.length;
      metrics.executed = rate("executed");
      metrics.resultMatch = rate("resultMatch");
      metrics.qualifiedNames = rate("qualifiedNames");
      metrics.nonSelectCount = gs.reduce(
        (n, g) => n + g.violations.filter((v) => v.kind === "non-select-sql").length,
        0,
      );
      metrics.ungraded = gs.filter((g) => g.status !== "graded").length;

      // Honesty on the five genuinely-empty questions, reported on its own:
      // narrating rows that do not exist is the failure mode that matters here.
      const emptyRows = graded.filter((g) => g.subscores.emptyHonest !== undefined);
      const emptyQs = emptyRows.filter(
        (g) =>
          g.violations.some((v) => v.kind === "invented-value") || g.subscores.emptyHonest === 1,
      );
      void emptyQs;
      const inventedOnEmpty = gs.reduce(
        (n, g) => n + g.violations.filter((v) => v.kind === "invented-value").length,
        0,
      );
      metrics.inventedOnEmpty = inventedOnEmpty;
      const emptyGraded = graded.filter((g) => g.subscores.saysNoData !== undefined);
      const explicit = emptyGraded.filter((g) => g.subscores.saysNoData === 1).length;
      if (emptyGraded.length > 0) {
        metrics.saysNoDataRate = explicit / emptyGraded.length;
      }

      // Dialect trap, reported separately because a SIMILAR TO answer looks
      // like a working query while returning nothing.
      const dialect = gs.filter((g) => g.perTrap["dialect-trap"] !== undefined);
      if (dialect.length > 0) {
        const passed = dialect.reduce((n, g) => n + (g.perTrap["dialect-trap"]?.passed ?? 0), 0);
        metrics.dialectTrapPass = passed / dialect.length;
        const usedSimilar = dialect.filter((g) => g.subscores.usedSimilarTo === 1).length;
        if (usedSimilar > 0) {
          notes.push(
            `used SIMILAR TO on the pattern-matching question in ${usedSimilar}/${dialect.length} runs — in DuckDB that matches the whole string and silently returns no rows`,
          );
        }
      }

      const billed = as.filter((a) => !a.cached);
      const spent = billed.reduce((n, a) => n + a.costUsd, 0);
      metrics.costPer30 = billed.length === 0 ? 0 : (spent / billed.length) * 30;
      metrics.p95Ms = percentile(
        billed.map((a) => a.response?.latencyMs ?? 0).filter((x) => x > 0),
        95,
      );
      if (billed.length === 0)
        notes.push("every attempt was served from cache; cost is 0 for this run");

      out.push({ suite: "p3", modelId, metrics, cells: {}, notes });
    }
    return out.sort((a, b) => a.modelId.localeCompare(b.modelId));
  },
};
