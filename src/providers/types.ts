import type { Capabilities, ProviderName, ProviderRequest, ProviderResponse } from "../types.js";

export interface ProviderModelInfo {
  id: string;
  /** Provider-reported concrete version, when it exposes one. */
  resolvedModel: string;
  /** Only the fields the provider actually tells us. Merged over defaults. */
  capabilities: Partial<Capabilities>;
}

export interface Provider {
  readonly name: ProviderName;
  readonly envKey: string;
  /** True when the API key is present. Missing key => provider is skipped, not failed. */
  isConfigured(): boolean;
  /** All model ids the key can see. Used by preflight. */
  listModels(): Promise<string[]>;
  /** Per-model detail. Returns null when the provider has no per-model endpoint. */
  describeModel(id: string): Promise<ProviderModelInfo | null>;
  complete(req: ProviderRequest, caps: Capabilities): Promise<ProviderResponse>;
}

/** Conservative defaults for a provider that tells us nothing. */
export const DEFAULT_CAPABILITIES: Capabilities = {
  temperature: true,
  stopSequences: true,
  jsonSchema: true,
  toolUse: true,
  images: false,
  thinkingModes: ["off"],
  effortLevels: [],
  maxInputTokens: null,
  maxOutputTokens: null,
};

export interface Degraded {
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  jsonSchema?: Record<string, unknown>;
  images?: { mime: string; b64: string }[];
  thinking: "disabled" | "adaptive" | "default";
  effort: string | null;
  paramsDropped: string[];
}

/**
 * Strip request params the model is known to reject, recording each one.
 *
 * This is the degrade-and-flag policy: the suite still runs and still scores,
 * and `paramsDropped` records exactly what never reached the wire so the
 * report can say "determinism measured at provider default" rather than
 * implying temp 0 was honoured.
 */
export function degradeRequest(req: ProviderRequest, caps: Capabilities): Degraded {
  const paramsDropped: string[] = [];
  const out: Degraded = {
    thinking: req.profile?.thinking ?? "default",
    effort: req.profile?.effort ?? null,
    paramsDropped,
  };

  // P6 probes bypass degradation entirely: the point is to find out what the
  // provider actually does, not to re-read our own capability table.
  if (req.probeRaw) {
    if (req.temperature !== undefined) out.temperature = req.temperature;
    if (req.stop !== undefined && req.stop.length > 0) out.stop = req.stop;
    if (req.jsonSchema !== undefined) out.jsonSchema = req.jsonSchema;
    if (req.images !== undefined && req.images.length > 0) out.images = req.images;
    if (req.maxTokens !== undefined) out.maxTokens = req.maxTokens;
    return out;
  }

  if (req.temperature !== undefined) {
    if (caps.temperature) out.temperature = req.temperature;
    else paramsDropped.push("temperature");
  }

  if (req.stop !== undefined && req.stop.length > 0) {
    if (caps.stopSequences) out.stop = req.stop;
    else paramsDropped.push("stop");
  }

  if (req.jsonSchema !== undefined) {
    if (caps.jsonSchema || caps.toolUse) out.jsonSchema = req.jsonSchema;
    else paramsDropped.push("jsonSchema");
  }

  if (req.images !== undefined && req.images.length > 0) {
    if (caps.images) out.images = req.images;
    else paramsDropped.push("images");
  }

  if (out.thinking === "disabled" && !caps.thinkingModes.includes("off")) {
    // Always-on thinking models (Fable 5) 400 on an explicit disable.
    out.thinking = "default";
    paramsDropped.push("thinking:disabled");
  }

  if (out.effort !== null && caps.effortLevels.length === 0) {
    out.effort = null;
    paramsDropped.push("effort");
  }

  if (req.maxTokens !== undefined) {
    out.maxTokens =
      caps.maxOutputTokens !== null ? Math.min(req.maxTokens, caps.maxOutputTokens) : req.maxTokens;
    if (out.maxTokens !== req.maxTokens) paramsDropped.push("maxTokens:clamped");
  }

  return out;
}

/**
 * Classify a provider error body into a structured refusal, or null when it is
 * a genuine transport/server failure that should be retried.
 *
 * A param rejection is data, not an exception: P6 scores it.
 */
export function classifyError(
  status: number,
  body: string,
): { kind: "param_rejected" | "schema_unsupported" | "content" | "other"; detail: string } | null {
  if (status !== 400 && status !== 422) return null;
  const lower = body.toLowerCase();
  const paramSignals = [
    "temperature",
    "top_p",
    "top_k",
    "budget_tokens",
    "stop_sequences",
    "thinking",
    "effort",
    "unsupported parameter",
    "unrecognized request argument",
    "does not support",
  ];
  if (paramSignals.some((s) => lower.includes(s))) {
    return { kind: "param_rejected", detail: truncate(body) };
  }
  const schemaSignals = [
    "json_schema",
    "response_format",
    "responseschema",
    "output_config",
    "schema",
  ];
  if (schemaSignals.some((s) => lower.includes(s))) {
    return { kind: "schema_unsupported", detail: truncate(body) };
  }
  return { kind: "other", detail: truncate(body) };
}

export function truncate(s: string, n = 600): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** Raised for transport / 5xx / 429 failures. The runner retries these. */
export class RetryableProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

/** Raised for non-retryable failures that are not param refusals (401, 404, …). */
export class FatalProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}
