import { randomUUID } from "node:crypto";
import type { JudgePanel } from "../graders/judge.js";
import type { Provider } from "../providers/types.js";
import type { Suite, SuiteAggregate, SuiteContext } from "../suites/types.js";
import { errored } from "../suites/types.js";
import {
  type Attempt,
  type GradeResult,
  type ProviderName,
  type ResolvedModel,
  type TaskSpec,
  costOf,
} from "../types.js";
import { type ResponseCache, cacheKey, isCacheable } from "./cache.js";
import { Semaphore, SemaphorePool } from "./concurrency.js";
import type { RunWriter } from "./manifest.js";
import { withRetry } from "./retry.js";
import type { SpendMeter } from "./spend.js";

export interface ProgressEvent {
  kind: "attempt" | "cap" | "retry";
  suite: string;
  modelId: string;
  itemId: string;
  cached?: boolean;
  costUsd?: number;
  message?: string;
}

export interface RunOptions {
  runId: string;
  suites: Suite[];
  models: ResolvedModel[];
  providers: Record<ProviderName, Provider>;
  cache: ResponseCache | null;
  spend: SpendMeter;
  concurrency: number;
  /** Explicit --repeats. Wins over everything. */
  repeatsOverride: number | null;
  /** --smoke ceiling. Caps suite/per-item repeats without flattening them to 1. */
  repeatsCap: number | null;
  ctx: SuiteContext;
  writer: RunWriter;
  /** --resume: successful attempts from a prior run, keyed by requestHash. */
  resumeIndex?: Map<string, Attempt>;
  /** Judge panel for P4/P5. Null when no judged suite is in the run. */
  judge?: JudgePanel | null;
  onProgress?: (ev: ProgressEvent) => void;
}

export interface RunOutcome {
  attempts: Attempt[];
  grades: GradeResult[];
  aggregates: SuiteAggregate[];
  abortedAtCap: boolean;
  cachedCount: number;
  errorCount: number;
  ungradedCount: number;
  /** Units the matrix planned. Compare against attempts to see what the cap ate. */
  plannedUnits: number;
  /** `suite modelId` -> planned units, so an aborted run can name what is short. */
  plannedBy: Record<string, number>;
}

interface Unit {
  suite: Suite;
  spec: TaskSpec;
  model: ResolvedModel;
  repeatIndex: number;
}

export async function runMatrix(opts: RunOptions): Promise<RunOutcome> {
  const attempts: Attempt[] = [];
  const grades: GradeResult[] = [];
  const pool = new SemaphorePool(opts.concurrency);

  // Build the full matrix up front so the dispatcher can stop cleanly at the cap.
  const units: Unit[] = [];
  for (const suite of opts.suites) {
    const items = await suite.loadItems(opts.ctx);
    for (const spec of items) {
      const declared = suite.repeatsForItem?.(spec) ?? suite.repeats;
      const repeats =
        opts.repeatsOverride ??
        (opts.repeatsCap === null ? declared : Math.min(declared, opts.repeatsCap));
      for (const model of opts.models) {
        for (let r = 0; r < repeats; r++) {
          units.push({ suite, spec, model, repeatIndex: r });
        }
      }
    }
  }

  /**
   * Perform one unit's provider call and return the attempt.
   *
   * Grading deliberately does NOT happen here. A judged suite's grader makes a
   * second API call, and doing that inside the candidate's provider slot means
   * one P4 item occupies a slot for two sequential round trips — halving
   * throughput and conflating two unrelated concurrency budgets.
   */
  async function runUnit(unit: Unit): Promise<{ attempt: Attempt; unit: Unit } | null> {
    {
      const { suite, spec, model, repeatIndex } = unit;
      const request = suite.buildRequest(spec, model.entry.id);
      const key = cacheKey({
        modelId: model.entry.id,
        resolvedModel: model.resolvedModel,
        request,
        fixturesVersion: opts.ctx.fixturesVersion,
        repeatIndex,
      });

      const base = {
        attemptId: randomUUID(),
        runId: opts.runId,
        suite: suite.id,
        itemId: spec.itemId,
        modelId: model.entry.id,
        resolvedModel: model.resolvedModel,
        repeatIndex,
        requestHash: key,
      };

      const resumed = opts.resumeIndex?.get(key);
      if (resumed?.response) {
        const attempt: Attempt = {
          ...base,
          cached: true,
          response: resumed.response,
          error: null,
          costUsd: 0,
        };
        return { attempt, unit };
      }

      const hit = opts.cache?.get(key) ?? null;
      if (hit) {
        const attempt: Attempt = {
          ...base,
          cached: true,
          response: hit.response,
          error: null,
          // A cache hit costs nothing this run; the original cost is not re-charged.
          costUsd: 0,
        };
        return { attempt, unit };
      }

      if (!opts.spend.reserve()) {
        opts.onProgress?.({
          kind: "cap",
          suite: suite.id,
          modelId: model.entry.id,
          itemId: spec.itemId,
          message: "spend cap reached; not dispatched",
        });
        return null;
      }

      const provider = opts.providers[model.entry.provider];
      const outcome = await withRetry(() => provider.complete(request, model.capabilities), {
        onRetry: (attempt, err, delayMs) =>
          opts.onProgress?.({
            kind: "retry",
            suite: suite.id,
            modelId: model.entry.id,
            itemId: spec.itemId,
            message: `attempt ${attempt} failed (${err.message}); retrying in ${delayMs}ms`,
          }),
      });

      if (!outcome.value) {
        const attempt: Attempt = {
          ...base,
          cached: false,
          response: null,
          error: {
            kind: outcome.error?.name ?? "Error",
            detail: outcome.error?.message ?? "unknown",
            attempts: outcome.attempts,
          },
          costUsd: 0,
        };
        return { attempt, unit };
      }

      const response = outcome.value;
      const cost = costOf(
        response.usage,
        model.entry.priceIn,
        model.entry.priceOut,
        model.entry.priceCachedIn,
      );
      opts.spend.add(cost);
      // A refusal caused by our own request must not be cached — see isCacheable.
      if (isCacheable(response))
        opts.cache?.put(
          key,
          {
            modelId: model.entry.id,
            resolvedModel: model.resolvedModel,
            fixturesVersion: opts.ctx.fixturesVersion,
          },
          response,
          cost,
        );

      const attempt: Attempt = {
        ...base,
        cached: false,
        response,
        error: null,
        costUsd: cost,
      };
      return { attempt, unit };
    }
  }

  // Units whose suite asks for serial repeats run as one chained task so that
  // repeat N+1 genuinely follows repeat N. Everything else fans out.
  const serialGroups = new Map<string, Unit[]>();
  const parallelUnits: Unit[] = [];
  for (const unit of units) {
    if (unit.suite.serialRepeats?.(unit.spec)) {
      const key = `${unit.suite.id}\u0000${unit.spec.itemId}\u0000${unit.model.entry.id}`;
      const list = serialGroups.get(key) ?? [];
      list.push(unit);
      serialGroups.set(key, list);
    } else {
      parallelUnits.push(unit);
    }
  }

  // Grading has its own budget. Judge calls go to a different provider than the
  // candidate and must not queue behind it, but they still need a ceiling or a
  // large judged suite would fire every judge request at once.
  const gradeLimit = new Semaphore(opts.concurrency);
  const graded = (r: { attempt: Attempt; unit: Unit } | null): Promise<unknown> =>
    r === null ? Promise.resolve(null) : gradeLimit.run(() => finish(r.attempt, r.unit));

  const tasks: Promise<unknown>[] = parallelUnits.map((unit) =>
    pool
      .for(unit.model.entry.provider)
      .run(() => runUnit(unit))
      .then(graded),
  );
  for (const group of serialGroups.values()) {
    const ordered = [...group].sort((a, b) => a.repeatIndex - b.repeatIndex);
    tasks.push(
      pool
        .for(ordered[0]!.model.entry.provider)
        // Serial applies to the CALLS — the cache probe needs repeat N+1 to
        // follow N on the wire. Their grading can happen afterwards.
        .run(async () => {
          const done: Array<{ attempt: Attempt; unit: Unit } | null> = [];
          for (const unit of ordered) done.push(await runUnit(unit));
          return done;
        })
        .then((done) => Promise.all(done.map(graded))),
    );
  }

  async function finish(attempt: Attempt, unit: Unit): Promise<null> {
    attempts.push(attempt);
    opts.writer.appendAttempt(attempt);
    opts.onProgress?.({
      kind: "attempt",
      suite: unit.suite.id,
      modelId: attempt.modelId,
      itemId: attempt.itemId,
      cached: attempt.cached,
      costUsd: attempt.costUsd,
    });

    // A grader failure must never take down the batch.
    let grade: GradeResult;
    if (attempt.error) {
      grade = errored(unit.spec, attempt);
    } else {
      try {
        grade = await unit.suite.grade(unit.spec, attempt, {
          judge: opts.judge ?? null,
          familyOf: (id) => opts.models.find((m) => m.entry.id === id)?.entry.family ?? "unknown",
        });
      } catch (err) {
        grade = {
          attemptId: attempt.attemptId,
          suite: unit.suite.id,
          itemId: unit.spec.itemId,
          modelId: attempt.modelId,
          status: "ungraded",
          ungradedReason: `grader threw: ${(err as Error).message}`,
          score: null,
          subscores: {},
          perTrap: {},
          violations: [],
          evidence: [],
        };
      }
    }
    grades.push(grade);
    return null;
  }

  await Promise.all(tasks);

  // Cross-repeat rollups (determinism, macro-F1, label-flip, tokenizer weight)
  // can only be computed once every attempt for a suite has landed.
  const aggregates: SuiteAggregate[] = [];
  for (const suite of opts.suites) {
    if (!suite.aggregate) continue;
    const suiteSpecs = [
      ...new Map(
        units.filter((u) => u.suite.id === suite.id).map((u) => [u.spec.itemId, u.spec]),
      ).values(),
    ];
    try {
      aggregates.push(
        ...suite.aggregate({
          specs: suiteSpecs,
          attempts: attempts.filter((a) => a.suite === suite.id),
          grades: grades.filter((g) => g.suite === suite.id),
          models: opts.models,
        }),
      );
    } catch (err) {
      // An aggregation bug must not destroy the per-item results already on disk.
      opts.onProgress?.({
        kind: "attempt",
        suite: suite.id,
        modelId: "-",
        itemId: "-",
        message: `aggregate failed: ${(err as Error).message}`,
      });
    }
  }

  return {
    attempts,
    grades,
    aggregates,
    abortedAtCap: opts.spend.isAborted,
    cachedCount: attempts.filter((a) => a.cached).length,
    errorCount: attempts.filter((a) => a.error !== null).length,
    ungradedCount: grades.filter((g) => g.status !== "graded").length,
    plannedUnits: units.length,
    plannedBy: units.reduce<Record<string, number>>((acc, u) => {
      const k = `${u.suite.id} ${u.model.entry.id}`;
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

/**
 * Approximate input tokens for a base64 image.
 *
 * Anthropic bills an image at roughly width*height/750 tokens. Reading the
 * PNG IHDR gives exact dimensions for a few bytes of work; anything else falls
 * back to a size-based guess so the estimate is never simply zero, which is
 * what it was before and which understated a vision suite by ~70x.
 */
export function estimateImageTokens(b64: string): number {
  // The IHDR width/height live at bytes 16..24, so 32 bytes of base64 suffice.
  const head = Buffer.from(b64.slice(0, 64), "base64");
  const isPng =
    head.length >= 24 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47;
  if (isPng) {
    const w = head.readUInt32BE(16);
    const h = head.readUInt32BE(20);
    if (w > 0 && h > 0 && w < 20000 && h < 20000) return Math.ceil((w * h) / 750);
  }
  // ~0.75 bytes of image per base64 char; a very rough fallback.
  return Math.ceil((b64.length * 0.75) / 750);
}

/** --dry-run: estimate cost with zero calls. Explicitly an estimate. */
export interface DryRunRow {
  suite: string;
  /** True when the suite caches its prompt prefix, so the estimate overstates. */
  cached: boolean;
  /** True when the estimate includes image tokens, which are approximate. */
  hasImages: boolean;
  modelId: string;
  items: number;
  repeats: number;
  calls: number;
  estInputTokens: number;
  estOutputTokens: number;
  estCostUsd: number;
}

export async function dryRun(opts: {
  suites: Suite[];
  models: ResolvedModel[];
  ctx: SuiteContext;
  repeatsOverride: number | null;
  repeatsCap: number | null;
}): Promise<DryRunRow[]> {
  const rows: DryRunRow[] = [];
  for (const suite of opts.suites) {
    const items = await suite.loadItems(opts.ctx);
    const repsFor = (spec: TaskSpec) => {
      const declared = suite.repeatsForItem?.(spec) ?? suite.repeats;
      return (
        opts.repeatsOverride ??
        (opts.repeatsCap === null ? declared : Math.min(declared, opts.repeatsCap))
      );
    };
    // Repeats vary per item (P6 runs one tokenizer probe but twenty schema
    // probes), so calls and tokens are summed item by item, not multiplied.
    const calls = items.reduce((n, s) => n + repsFor(s), 0);
    const maxReps = Math.max(...items.map(repsFor), 1);
    for (const model of opts.models) {
      let estIn = 0;
      let hasImages = false;
      for (const spec of items) {
        const req = suite.buildRequest(spec, model.entry.id);
        const chars =
          (req.system?.length ?? 0) + req.messages.reduce((n, m) => n + m.content.length, 0);
        // ~4 chars/token is a rough English prior. Labelled an estimate in the
        // table; real spend is always metered from live usage counts.
        let perCall = Math.ceil(chars / 4);
        // Images dominate a vision request and were previously not counted at
        // all, so P7 estimated at a seventieth of its real input.
        for (const img of req.images ?? []) {
          hasImages = true;
          perCall += estimateImageTokens(img.b64);
        }
        estIn += perCall * repsFor(spec);
      }
      const estOut = items.reduce(
        (n, s) =>
          n +
          repsFor(s) *
            Math.min(
              suite.estimatedOutputTokensPerItem,
              s.requestOverrides?.maxTokens ?? Number.POSITIVE_INFINITY,
            ),
        0,
      );
      const usesCache = items.some((s) => suite.buildRequest(s, model.entry.id).cacheable === true);
      rows.push({
        suite: suite.id,
        cached: usesCache,
        modelId: model.entry.id,
        items: items.length,
        repeats: maxReps,
        calls,
        hasImages,
        estInputTokens: estIn,
        estOutputTokens: estOut,
        estCostUsd:
          (estIn / 1_000_000) * model.entry.priceIn + (estOut / 1_000_000) * model.entry.priceOut,
      });
    }
  }
  return rows;
}
