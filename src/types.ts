import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Provider layer
 * ------------------------------------------------------------------ */

export const ProviderName = z.enum(["anthropic", "openai", "google", "openrouter"]);
export type ProviderName = z.infer<typeof ProviderName>;

/** Thinking modes a model supports. `off` means it can be explicitly disabled. */
export const ThinkingMode = z.enum(["off", "adaptive", "always-on"]);
export type ThinkingMode = z.infer<typeof ThinkingMode>;

/**
 * What a model will actually accept. Resolved at preflight from the provider
 * where the provider exposes it, else from the models.yaml override.
 *
 * `temperature: false` means sending `temperature` returns a 400. That is the
 * normal case on current frontier models (Opus 5, Opus 4.8/4.7, Sonnet 5,
 * Fable 5), not an exotic one.
 */
export const Capabilities = z.object({
  temperature: z.boolean(),
  stopSequences: z.boolean(),
  /** Native forced structured output (json_schema / response_format / responseSchema). */
  jsonSchema: z.boolean(),
  toolUse: z.boolean(),
  images: z.boolean(),
  thinkingModes: z.array(ThinkingMode),
  /** Empty array when the model has no effort parameter. */
  effortLevels: z.array(z.string()),
  maxInputTokens: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
});
export type Capabilities = z.infer<typeof Capabilities>;

/** Per-model request shaping, from models.yaml. Mirrors the production call. */
export const RequestProfile = z.object({
  /** `disabled` asks the provider to turn thinking off; `default` leaves it alone. */
  thinking: z.enum(["disabled", "adaptive", "default"]).default("default"),
  effort: z.string().nullable().default(null),
});
export type RequestProfile = z.infer<typeof RequestProfile>;

export const Msg = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});
export type Msg = z.infer<typeof Msg>;

export const ImageInput = z.object({
  mime: z.string(),
  b64: z.string(),
});
export type ImageInput = z.infer<typeof ImageInput>;

export const ProviderRequest = z.object({
  model: z.string(),
  system: z.string().optional(),
  messages: z.array(Msg),
  /** Forced structured output / tool-use JSON schema. */
  jsonSchema: z.record(z.unknown()).optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().int().positive().optional(),
  stop: z.array(z.string()).optional(),
  images: z.array(ImageInput).optional(),
  profile: RequestProfile.optional(),
  /** Ask the provider to cache this prompt prefix. Used by the P6 cache probe. */
  cacheable: z.boolean().optional(),
  /**
   * Cache lifetime. A long suite outruns the 5-minute default, so P5 asks for
   * an hour: the write costs 2x instead of 1.25x, which is far cheaper than
   * re-billing a 90k-token vault on every question.
   */
  cacheTtl: z.enum(["5m", "1h"]).optional(),
  /**
   * Send parameters exactly as given, skipping capability-based degradation.
   *
   * P6 sets this so the PROVIDER answers "is temperature accepted", not our own
   * capability table. Otherwise the probe would just be testing models.yaml
   * against itself, and a wrong entry would never be caught.
   */
  probeRaw: z.boolean().optional(),
});
export type ProviderRequest = z.infer<typeof ProviderRequest>;

export const RefusalKind = z.enum(["param_rejected", "schema_unsupported", "content", "other"]);
export type RefusalKind = z.infer<typeof RefusalKind>;

export const Refusal = z.object({
  kind: RefusalKind,
  detail: z.string(),
});
export type Refusal = z.infer<typeof Refusal>;

/**
 * Normalised at the adapter, because providers disagree about what their
 * prompt-token field means. Here the three input buckets are always DISJOINT:
 *
 *   total prompt tokens = in + cachedIn + cacheWriteIn
 *
 * Anthropic reports `input_tokens` already exclusive of cache reads/writes;
 * OpenAI and Google report a total with cached tokens as a subset. Each adapter
 * converts to this shape so cost is computed once, correctly.
 */
export const Usage = z.object({
  /** Uncached prompt tokens, billed at the full input rate. */
  in: z.number().nonnegative(),
  out: z.number().nonnegative(),
  /** Cache reads, billed at ~0.1x. */
  cachedIn: z.number().nonnegative().optional(),
  /** Cache writes, billed at ~1.25x (5m TTL) or ~2x (1h TTL). */
  cacheWriteIn: z.number().nonnegative().optional(),
  /** True when the write used the 1h TTL, which bills at 2x rather than 1.25x. */
  cacheWriteLongTtl: z.boolean().optional(),
});
export type Usage = z.infer<typeof Usage>;

/** Every prompt token, regardless of which cache bucket it landed in. */
export function totalInputTokens(u: Usage): number {
  return u.in + (u.cachedIn ?? 0) + (u.cacheWriteIn ?? 0);
}

export const ProviderResponse = z.object({
  text: z.string().optional(),
  json: z.unknown().optional(),
  usage: Usage,
  latencyMs: z.number().nonnegative(),
  raw: z.unknown(),
  refusal: Refusal.optional(),
  /**
   * Params the adapter stripped before sending because Capabilities said the
   * provider would reject them. This is the audit trail for degrade-and-flag:
   * the suite still runs, and the report can say exactly what was not sent.
   */
  paramsDropped: z.array(z.string()).default([]),
  /** Non-null when the response was truncated by the output cap. */
  stopReason: z.string().nullable().default(null),
});
export type ProviderResponse = z.infer<typeof ProviderResponse>;

/* ------------------------------------------------------------------ *
 * Fixtures and gold
 * ------------------------------------------------------------------ */

export const TrapType = z.enum([
  "none",
  "unit-trap",
  "distractor",
  "absent",
  "stale",
  "spelled-number",
  "dialect-trap",
]);
export type TrapType = z.infer<typeof TrapType>;

/** A normalized quantity: value expressed in `unit`'s base units. */
export const Canonical = z.object({
  value: z.number().nullable(),
  unit: z.string().nullable(),
});
export type Canonical = z.infer<typeof Canonical>;

export const PlantedFact = z.object({
  id: z.string(),
  field: z.string(),
  /** null for an `absent` trap: the correct answer is "no data". */
  value: z.union([z.number(), z.string(), z.null()]),
  unit: z.string().nullable(),
  canonical: Canonical,
  /** null for an `absent` trap: there is nothing in the source to quote. */
  quote: z.string().nullable(),
  trapType: TrapType,
});
export type PlantedFact = z.infer<typeof PlantedFact>;

export const TaskSpec = z.object({
  suite: z.string(),
  itemId: z.string(),
  fixtureVersion: z.string(),
  prompt: z.object({
    system: z.string().optional(),
    user: z.string(),
  }),
  jsonSchema: z.record(z.unknown()).optional(),
  requestOverrides: z
    .object({
      temperature: z.number().optional(),
      maxTokens: z.number().int().positive().optional(),
      stop: z.array(z.string()).optional(),
    })
    .optional(),
  images: z.array(ImageInput).optional(),
  /** Suite-specific; each grader narrows this with its own schema. */
  gold: z.unknown(),
  weight: z.number().positive().default(1),
});
export type TaskSpec = z.infer<typeof TaskSpec>;

/* ------------------------------------------------------------------ *
 * Execution
 * ------------------------------------------------------------------ */

export const AttemptError = z.object({
  kind: z.string(),
  detail: z.string(),
  attempts: z.number().int().positive(),
});
export type AttemptError = z.infer<typeof AttemptError>;

export const Attempt = z.object({
  attemptId: z.string(),
  runId: z.string(),
  suite: z.string(),
  itemId: z.string(),
  modelId: z.string(),
  resolvedModel: z.string(),
  repeatIndex: z.number().int().nonnegative(),
  requestHash: z.string(),
  cached: z.boolean(),
  response: ProviderResponse.nullable(),
  /** Non-null only after retries are exhausted. Never silently dropped. */
  error: AttemptError.nullable(),
  costUsd: z.number().nonnegative(),
});
export type Attempt = z.infer<typeof Attempt>;

/* ------------------------------------------------------------------ *
 * Grading
 * ------------------------------------------------------------------ */

/** The hallucination ledger. Every entry is a concrete, evidenced failure. */
export const ViolationKind = z.enum([
  "invented-value",
  "fabricated-quote",
  "untraceable-number",
  "relitigated-item",
  "non-select-sql",
  "rule-trap-complied",
  "schema-invalid",
]);
export type ViolationKind = z.infer<typeof ViolationKind>;

export const Violation = z.object({
  kind: ViolationKind,
  detail: z.string(),
  factId: z.string().nullable(),
});
export type Violation = z.infer<typeof Violation>;

export const TrapTally = z.object({
  n: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
});
export type TrapTally = z.infer<typeof TrapTally>;

/**
 * A grader never guesses. If it cannot score an item it emits
 * `status: "ungraded"` with a reason and a null score, and the report counts it.
 */
export const GradeResult = z.object({
  attemptId: z.string(),
  suite: z.string(),
  itemId: z.string(),
  modelId: z.string(),
  status: z.enum(["graded", "ungraded", "error"]),
  ungradedReason: z.string().nullable(),
  score: z.number().min(0).max(1).nullable(),
  subscores: z.record(z.number()),
  perTrap: z.record(TrapTally),
  violations: z.array(Violation),
  /** Verbatim evidence for the drill-down view. Graders must not paraphrase. */
  evidence: z.array(z.string()),
});
export type GradeResult = z.infer<typeof GradeResult>;

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

export const PipelineRole = z.enum(["classify", "extract", "sql", "write", "session", "vision"]);
export type PipelineRole = z.infer<typeof PipelineRole>;

export const ModelEntry = z.object({
  id: z.string(),
  provider: ProviderName,
  /** Judge-collision grouping. Usually the same as `provider`. */
  family: z.string(),
  /** USD per million tokens. */
  priceIn: z.number().nonnegative(),
  priceOut: z.number().nonnegative(),
  priceCachedIn: z.number().nonnegative().nullable().default(null),
  baseline: z.boolean().default(false),
  roles: z.array(PipelineRole).default([]),
  /**
   * Roles this model is the baseline FOR. Defaults to all of `roles`.
   *
   * Needed because `baseline` is one flag but `roles` is a list: without this,
   * the classify baseline silently becomes the baseline for every other role it
   * happens to list, and the verdict engine compares against the wrong incumbent.
   */
  baselineRoles: z.array(PipelineRole).optional(),
  profile: RequestProfile.default({ thinking: "default", effort: null }),
  /** Optional override; preflight warns when it contradicts the live API. */
  capabilities: Capabilities.partial().optional(),
  notes: z.string().optional(),
});
export type ModelEntry = z.infer<typeof ModelEntry>;

export const ModelsFile = z.array(ModelEntry);
export type ModelsFile = z.infer<typeof ModelsFile>;

export const JudgeEntry = z.object({
  id: z.string(),
  provider: ProviderName,
  family: z.string(),
  priceIn: z.number().nonnegative(),
  priceOut: z.number().nonnegative(),
  profile: RequestProfile.default({ thinking: "default", effort: null }),
  /** Same optional override models get; preflight warns if it contradicts the API. */
  capabilities: Capabilities.partial().optional(),
});
export type JudgeEntry = z.infer<typeof JudgeEntry>;

export const JudgesFile = z.object({
  /** Pinned. Never auto-upgraded. Recorded in every manifest. */
  primary: JudgeEntry,
  secondary: JudgeEntry.nullable().default(null),
  rubricVersion: z.string(),
});
export type JudgesFile = z.infer<typeof JudgesFile>;

/** A model after preflight: registry entry + what the provider actually says. */
export const ResolvedModel = z.object({
  entry: ModelEntry,
  resolvedModel: z.string(),
  capabilities: Capabilities,
  /** Preflight disagreements between models.yaml and the live API. */
  capabilityWarnings: z.array(z.string()).default([]),
});
export type ResolvedModel = z.infer<typeof ResolvedModel>;

/* ------------------------------------------------------------------ *
 * Manifest
 * ------------------------------------------------------------------ */

export const ManifestModel = z.object({
  id: z.string(),
  provider: ProviderName,
  resolvedModel: z.string(),
  capabilities: Capabilities,
  profile: RequestProfile,
  priceIn: z.number(),
  priceOut: z.number(),
  baseline: z.boolean(),
  roles: z.array(PipelineRole),
  capabilityWarnings: z.array(z.string()),
});
export type ManifestModel = z.infer<typeof ManifestModel>;

export const RunManifest = z.object({
  runId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  gitSha: z.string().nullable(),
  fixturesVersion: z.string(),
  cliArgs: z.record(z.unknown()),
  seeds: z.record(z.number()),
  models: z.array(ManifestModel),
  judges: z.array(
    z.object({
      id: z.string(),
      resolvedModel: z.string(),
      rubricVersion: z.string(),
      promptHash: z.string(),
    }),
  ),
  skippedProviders: z.array(z.object({ provider: ProviderName, reason: z.string() })),
  totalCostUsd: z.number().nonnegative(),
  wallMs: z.number().nonnegative(),
  abortedAtCap: z.boolean().default(false),
  counts: z.object({
    attempts: z.number().int().nonnegative(),
    cached: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    ungraded: z.number().int().nonnegative(),
  }),
});
export type RunManifest = z.infer<typeof RunManifest>;

/* ------------------------------------------------------------------ *
 * Cost
 * ------------------------------------------------------------------ */

/**
 * Usage counts are live; prices come from the registry.
 *
 * The three input buckets are disjoint (see Usage), so they are simply summed
 * at their own rates — no subtraction. Cache writes cost MORE than uncached
 * input, which is why they cannot be ignored: a run that writes a large cache
 * and never reads it is more expensive than one that never cached at all.
 */
export function costOf(
  usage: Usage,
  priceIn: number,
  priceOut: number,
  priceCachedIn?: number | null,
): number {
  const readRate = priceCachedIn ?? priceIn * 0.1;
  const writeRate = priceIn * (usage.cacheWriteLongTtl ? 2 : 1.25);
  return (
    (usage.in / 1_000_000) * priceIn +
    ((usage.cachedIn ?? 0) / 1_000_000) * readRate +
    ((usage.cacheWriteIn ?? 0) / 1_000_000) * writeRate +
    (usage.out / 1_000_000) * priceOut
  );
}
