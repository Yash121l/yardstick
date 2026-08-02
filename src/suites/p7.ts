import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CAPTURES, type Capture, type InvoiceGold } from "../generators/p7.js";
import type { Attempt, GradeResult, ProviderRequest, TaskSpec } from "../types.js";
import type { AggregateInput, Suite, SuiteAggregate, SuiteContext } from "./types.js";
import { errored, ungraded } from "./types.js";

/**
 * P7 — vision extraction from rendered invoices.
 *
 * The same shape of question as P1, asked of pixels instead of prose: pull a
 * fixed set of fields out of a document, quote nothing you cannot see, and say
 * null when a field is not there. Four of the twelve invoices are zero-rated
 * and print no tax line at all, and a third print no tax id; returning 0 or a
 * plausible-looking number for those is the failure this suite is built to
 * separate from ordinary reading errors.
 *
 * Models without image input are skipped, not scored 0.
 */

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "vendor",
    "invoiceNumber",
    "date",
    "currency",
    "subtotal",
    "tax",
    "total",
    "taxId",
    "poNumber",
    "lineItems",
  ],
  properties: {
    vendor: { type: ["string", "null"] },
    invoiceNumber: { type: ["string", "null"] },
    date: { type: ["string", "null"], description: "ISO 8601, YYYY-MM-DD" },
    currency: { type: ["string", "null"], description: "ISO 4217, e.g. INR or USD" },
    subtotal: { type: ["number", "null"], description: "major units, e.g. 48434.80" },
    tax: { type: ["number", "null"], description: "null if the invoice shows no tax line" },
    total: { type: ["number", "null"] },
    taxId: { type: ["string", "null"], description: "GSTIN or EIN; null if not printed" },
    poNumber: { type: ["string", "null"], description: "null if no PO is referenced" },
    lineItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "qty", "amount"],
        properties: {
          description: { type: "string" },
          qty: { type: "number" },
          amount: { type: "number", description: "line total in major units" },
        },
      },
    },
  },
} as const;

const SYSTEM = [
  "You read scanned and photographed invoices and return structured data.",
  "",
  "Rules:",
  "- Report only what is printed on the document. Do not compute a field that is",
  "  not shown, and do not infer one from the others.",
  "- If a field is genuinely absent from the document, return null for it.",
  "  null is the correct answer for an absent field. 0 is not, and neither is a",
  "  plausible guess.",
  "- Amounts are in major units with decimals, without grouping separators or a",
  "  currency symbol: 1,14,787.52 is 114787.52.",
].join("\n");

interface P7Gold extends InvoiceGold {
  imagePath: string;
  capture: Capture;
}

function goldPath(root: string): string {
  return join(root, "suites", "p7-vision", "gold", "invoices.json");
}

/** Major-unit number from the stored minor-unit integer. */
const major = (minor: number): number => Math.round(minor) / 100;

export const p7Suite: Suite = {
  id: "p7",
  title: "Vision extraction from rendered invoices",
  repeats: 2,
  roles: ["vision"],
  // Forced JSON matters here; temperature does not, and several vision-capable
  // models reject it outright.
  requiredParams: ["jsonSchema"],
  // Measured at ~180 output tokens per invoice; 300 leaves headroom without
  // inflating the dry-run estimate threefold.
  estimatedOutputTokensPerItem: 300,
  usesJudge: false,

  async loadItems(ctx: SuiteContext): Promise<TaskSpec[]> {
    const gp = goldPath(ctx.root);
    if (!existsSync(gp)) {
      throw new Error("P7 fixtures are missing. Run `npm run gen -- p7` first.");
    }
    const invoices = JSON.parse(readFileSync(gp, "utf8")) as InvoiceGold[];
    const specs: TaskSpec[] = [];
    // One item per (document, capture). The same content at three qualities is
    // what makes the degradation curve a within-document comparison.
    for (const g of invoices) {
      for (const capture of CAPTURES) {
        const imagePath = join(
          ctx.root,
          "suites",
          "p7-vision",
          "fixtures",
          `${g.id}-${capture}.png`,
        );
        if (!existsSync(imagePath)) throw new Error(`P7 fixture image missing: ${imagePath}`);
        specs.push({
          suite: "p7",
          itemId: `${g.id}-${capture}`,
          fixtureVersion: ctx.fixturesVersion,
          prompt: {
            system: SYSTEM,
            user: "Extract the fields from this invoice. Return null for any field the document does not show.",
          },
          jsonSchema: SCHEMA as unknown as Record<string, unknown>,
          gold: { ...g, imagePath, capture } satisfies P7Gold,
          weight: 1,
        });
      }
      if (ctx.maxItems !== null && specs.length >= ctx.maxItems * CAPTURES.length) break;
    }
    return specs;
  },

  buildRequest(spec: TaskSpec, modelId: string): ProviderRequest {
    const g = spec.gold as P7Gold;
    return {
      model: modelId,
      system: spec.prompt.system,
      messages: [{ role: "user", content: spec.prompt.user }],
      jsonSchema: spec.jsonSchema,
      maxTokens: 1500,
      images: [{ mime: "image/png", b64: readFileSync(g.imagePath).toString("base64") }],
    };
  },

  async grade(spec: TaskSpec, attempt: Attempt): Promise<GradeResult> {
    if (attempt.error) return errored(spec, attempt);
    const res = attempt.response;
    if (!res) return errored(spec, attempt);

    // A model that cannot take an image was never asked the question.
    if ((res.paramsDropped ?? []).includes("images")) {
      return ungraded(
        spec,
        attempt,
        "model does not accept image input; the document was never sent",
      );
    }
    if (res.refusal) return ungraded(spec, attempt, `refused: ${res.refusal.detail}`);

    const g = spec.gold as P7Gold;
    const parsed = (res.json ?? tryParse(res.text)) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") {
      return {
        ...ungraded(spec, attempt, "no parseable JSON object in the response"),
        status: "graded",
        score: 0,
        subscores: { schemaValid: 0 },
      };
    }

    const evidence: string[] = [];
    const violations: GradeResult["violations"] = [];
    const perTrap: GradeResult["perTrap"] = {};

    const bump = (trap: string, passed: boolean) => {
      const cur = perTrap[trap] ?? { n: 0, passed: 0 };
      perTrap[trap] = { n: cur.n + 1, passed: cur.passed + (passed ? 1 : 0) };
    };

    // --- present fields: correct value required ---
    const checks: Array<{ field: string; got: unknown; want: string | number | null }> = [
      { field: "vendor", got: parsed.vendor, want: g.vendor },
      { field: "invoiceNumber", got: parsed.invoiceNumber, want: g.invoiceNumber },
      { field: "date", got: parsed.date, want: g.date },
      { field: "currency", got: parsed.currency, want: g.currency },
      { field: "subtotal", got: parsed.subtotal, want: major(g.subtotalMinor) },
      { field: "total", got: parsed.total, want: major(g.totalMinor) },
      { field: "tax", got: parsed.tax, want: g.taxMinor === null ? null : major(g.taxMinor) },
      { field: "taxId", got: parsed.taxId, want: g.taxId },
      { field: "poNumber", got: parsed.poNumber, want: g.poNumber },
    ];

    let presentHits = 0;
    let presentTotal = 0;
    let absentHonest = 0;
    let absentTotal = 0;

    for (const c of checks) {
      const isAbsent = c.want === null;
      const ok = fieldMatches(c.got, c.want);
      if (isAbsent) {
        absentTotal++;
        if (ok) absentHonest++;
        else {
          violations.push({
            kind: "invented-value",
            detail: `${c.field} is not printed on this invoice; model returned ${JSON.stringify(c.got)}`,
            factId: c.field,
          });
          evidence.push(`INVENTED ${c.field}=${JSON.stringify(c.got)} (absent from the document)`);
        }
        bump("absent", ok);
      } else {
        presentTotal++;
        if (ok) presentHits++;
        else
          evidence.push(`${c.field}: want ${JSON.stringify(c.want)}, got ${JSON.stringify(c.got)}`);
        bump(numericField(c.field) ? "amount" : "text", ok);
      }
    }

    // --- line items: count and amounts ---
    const gotItems = Array.isArray(parsed.lineItems)
      ? (parsed.lineItems as Record<string, unknown>[])
      : [];
    const wantAmounts = g.lineItems.map((l) => major(l.amountMinor)).sort((a, b) => a - b);
    const gotAmounts = gotItems
      .map((l) => (typeof l.amount === "number" ? l.amount : Number.NaN))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    const itemCountOk = gotItems.length === g.lineItems.length;
    let amountHits = 0;
    for (const want of wantAmounts) {
      const idx = gotAmounts.findIndex((x) => Math.abs(x - want) < 0.005);
      if (idx >= 0) {
        amountHits++;
        gotAmounts.splice(idx, 1);
      }
    }
    const lineItemScore = wantAmounts.length === 0 ? 1 : amountHits / wantAmounts.length;
    if (!itemCountOk) {
      evidence.push(`line items: want ${g.lineItems.length}, got ${gotItems.length}`);
    }
    bump("lineItems", itemCountOk && lineItemScore === 1);

    const fieldAccuracy = presentTotal === 0 ? 1 : presentHits / presentTotal;
    const honestNull = absentTotal === 0 ? 1 : absentHonest / absentTotal;

    // An invented value on an absent field is weighted heavily on purpose: a
    // wrong reading is a mistake, a confident number for a field that is not
    // on the page is the thing that quietly corrupts a downstream ledger.
    const score = 0.5 * fieldAccuracy + 0.3 * honestNull + 0.2 * lineItemScore;

    const subscores: Record<string, number> = {
      schemaValid: 1,
      fieldAccuracy,
      honestNull,
      lineItemAmounts: lineItemScore,
      lineItemCountOk: itemCountOk ? 1 : 0,
      inventedValues: violations.length,
      [`capture:${g.capture}`]: score,
      [`layout:${g.layout}`]: score,
    };
    if (absentTotal > 0) subscores.absentFields = absentTotal;

    return {
      attemptId: attempt.attemptId,
      suite: "p7",
      itemId: spec.itemId,
      modelId: attempt.modelId,
      status: "graded",
      ungradedReason: null,
      score,
      subscores,
      perTrap,
      violations,
      evidence,
    };
  },

  aggregate({ grades, attempts }: AggregateInput): SuiteAggregate[] {
    const byModel = new Map<string, string[]>();
    for (const g of grades) {
      if (!byModel.has(g.modelId)) byModel.set(g.modelId, []);
    }
    const out: SuiteAggregate[] = [];

    for (const modelId of byModel.keys()) {
      const gs = grades.filter((x) => x.modelId === modelId && x.suite === "p7");
      const graded = gs.filter((x) => x.status === "graded" && x.score !== null);
      const as = attempts.filter((a) => a.modelId === modelId && a.suite === "p7");
      const metrics: Record<string, number> = {};
      const notes: string[] = [];

      const skipped = gs.filter((x) => x.ungradedReason?.includes("image input"));
      if (skipped.length > 0 && graded.length === 0) {
        notes.push("skipped: this model does not accept image input, so P7 was never asked of it");
        out.push({ suite: "p7", modelId, metrics: { ungraded: gs.length }, cells: {}, notes });
        continue;
      }

      if (graded.length > 0) {
        const mean = (k: string) =>
          graded.reduce((n, x) => n + (x.subscores[k] ?? 0), 0) / graded.length;
        metrics.score = graded.reduce((n, x) => n + (x.score as number), 0) / graded.length;
        metrics.fieldAccuracy = mean("fieldAccuracy");
        metrics.honestNull = mean("honestNull");
        metrics.lineItemAmounts = mean("lineItemAmounts");
        metrics.lineItemCountOk = mean("lineItemCountOk");

        const absent = graded.reduce((n, x) => n + (x.subscores.absentFields ?? 0), 0);
        const invented = graded.reduce((n, x) => n + (x.subscores.inventedValues ?? 0), 0);
        metrics.inventedValues = invented;
        // Per 100 absent fields, which is the exposure that matters, rather
        // than per document, which varies with how many blanks a layout has.
        metrics.hallucinationPer100 = absent === 0 ? 0 : (invented / absent) * 100;

        // Capture quality is the whole point of rendering photographs, so it is
        // reported as its own curve rather than averaged into one number.
        for (const capture of ["scan", "photo", "poor"]) {
          const sub = graded.filter((x) => x.subscores[`capture:${capture}`] !== undefined);
          if (sub.length > 0) {
            metrics[`capture:${capture}`] =
              sub.reduce((n, x) => n + (x.subscores[`capture:${capture}`] as number), 0) /
              sub.length;
          }
        }
      }

      metrics.ungraded = gs.filter((x) => x.status !== "graded").length;
      const billed = as.filter((a) => !a.cached);
      if (billed.length > 0) {
        metrics.costPerDoc = billed.reduce((n, a) => n + a.costUsd, 0) / billed.length;
      }
      if (skipped.length > 0) {
        notes.push(`${skipped.length} item(s) skipped: no image input on this model`);
      }
      out.push({ suite: "p7", modelId, metrics, cells: {}, notes });
    }
    return out;
  },
};

function numericField(f: string): boolean {
  return f === "subtotal" || f === "total" || f === "tax";
}

function tryParse(text: string | undefined): unknown {
  if (!text) return null;
  const i = text.indexOf("{");
  if (i < 0) return null;
  try {
    return JSON.parse(text.slice(i));
  } catch {
    return null;
  }
}

/** Normalise a printed string for comparison without discarding real differences. */
function norm(s: string): string {
  return s.toUpperCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
}

export function fieldMatches(got: unknown, want: string | number | null): boolean {
  if (want === null) {
    // Absent means absent. An empty string, "N/A" and 0 are all a model
    // declining to say null, and each would corrupt a ledger differently.
    return got === null || got === undefined;
  }
  if (typeof want === "number") {
    if (typeof got === "number") return Math.abs(got - want) < 0.005;
    if (typeof got === "string") {
      const cleaned = Number.parseFloat(got.replace(/[^0-9.-]/g, ""));
      return Number.isFinite(cleaned) && Math.abs(cleaned - want) < 0.005;
    }
    return false;
  }
  if (typeof got !== "string") return false;
  return norm(got) === norm(want);
}
