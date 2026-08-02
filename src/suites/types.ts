import type { JudgePanel } from "../graders/judge.js";
import type {
  Attempt,
  GradeResult,
  PipelineRole,
  ProviderRequest,
  ResolvedModel,
  TaskSpec,
} from "../types.js";

/** One cell of the P6 quirks matrix. */
export interface AggregateCell {
  status: "pass" | "fail" | "ignored" | "na";
  detail: string;
}

/**
 * Cross-item and cross-repeat metrics. Determinism, macro-F1, label-flip rate
 * and tokenizer weight cannot be computed from a single attempt, so suites
 * that need them implement `aggregate`.
 */
export interface SuiteAggregate {
  suite: string;
  modelId: string;
  metrics: Record<string, number>;
  cells: Record<string, AggregateCell>;
  notes: string[];
}

export interface AggregateInput {
  specs: TaskSpec[];
  attempts: Attempt[];
  grades: GradeResult[];
  models: ResolvedModel[];
}

/** Passed to every grader. Suites that need no judge simply ignore it. */
export interface GradeContext {
  judge: JudgePanel | null;
  /** Authoritative family from models.yaml, for the judge-collision check. */
  familyOf(modelId: string): string;
}

export interface SuiteContext {
  root: string;
  fixturesVersion: string;
  /** --smoke caps items per suite. */
  maxItems: number | null;
}

export interface Suite {
  readonly id: string;
  readonly title: string;
  /** Default repeat count; --repeats overrides. */
  readonly repeats: number;
  /** Pipeline roles this suite informs, for the verdict engine. */
  readonly roles: PipelineRole[];
  /** Params this suite genuinely needs. A P6 red cell here is verdict-blocking. */
  readonly requiredParams: ("temperature" | "jsonSchema" | "stopSequences")[];
  /** Used only by --dry-run. Labelled an estimate everywhere it is shown. */
  readonly estimatedOutputTokensPerItem: number;
  /** True when grading needs an LLM judge, which triggers the collision check. */
  readonly usesJudge: boolean;

  loadItems(ctx: SuiteContext): Promise<TaskSpec[]>;
  /**
   * Per-item repeat count. Lets one suite hold a 5-repeat determinism probe and
   * a 1-repeat 10k-token tokenizer probe without paying for five of the latter.
   * An explicit --repeats / --smoke override still wins.
   */
  repeatsForItem?(spec: TaskSpec): number;
  /**
   * Run this item's repeats strictly in sequence.
   *
   * Needed by the prompt-cache probe: a cache entry only becomes readable once
   * the first response has started, so firing both repeats concurrently makes
   * a cache hit a coin flip rather than a measurement.
   */
  serialRepeats?(spec: TaskSpec): boolean;
  /** Build the wire request for one item. */
  buildRequest(spec: TaskSpec, modelId: string): ProviderRequest;
  grade(spec: TaskSpec, attempt: Attempt, ctx: GradeContext): Promise<GradeResult>;
  /** Optional cross-repeat / cross-item rollup, one row per model. */
  aggregate?(input: AggregateInput): SuiteAggregate[];
}

/** Shared helper: an ungraded result, with the reason, never a guessed score. */
export function ungraded(spec: TaskSpec, attempt: Attempt, reason: string): GradeResult {
  return {
    attemptId: attempt.attemptId,
    suite: spec.suite,
    itemId: spec.itemId,
    modelId: attempt.modelId,
    status: "ungraded",
    ungradedReason: reason,
    score: null,
    subscores: {},
    perTrap: {},
    violations: [],
    evidence: [],
  };
}

export function errored(spec: TaskSpec, attempt: Attempt): GradeResult {
  return {
    attemptId: attempt.attemptId,
    suite: spec.suite,
    itemId: spec.itemId,
    modelId: attempt.modelId,
    status: "error",
    ungradedReason: attempt.error
      ? `${attempt.error.kind}: ${attempt.error.detail}`
      : "unknown error",
    score: null,
    subscores: {},
    perTrap: {},
    violations: [],
    evidence: [],
  };
}
