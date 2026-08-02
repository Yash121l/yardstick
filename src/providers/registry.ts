import type { Capabilities, ModelEntry, ProviderName, ResolvedModel } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
import { OpenAIProvider } from "./openai.js";
import { OpenRouterProvider } from "./openrouter.js";
import { DEFAULT_CAPABILITIES, type Provider } from "./types.js";

export function buildProviders(): Record<ProviderName, Provider> {
  return {
    anthropic: new AnthropicProvider(),
    openai: new OpenAIProvider(),
    google: new GoogleProvider(),
    openrouter: new OpenRouterProvider(),
  };
}

export class PreflightError extends Error {}

export interface PreflightResult {
  resolved: ResolvedModel[];
  skipped: { provider: ProviderName; reason: string }[];
}

export function mergeCapabilities(
  fromProvider: Partial<Capabilities>,
  fromYaml: Partial<Capabilities> | undefined,
  modelId: string,
): { caps: Capabilities; warnings: string[] } {
  const warnings: string[] = [];
  const merged: Capabilities = { ...DEFAULT_CAPABILITIES, ...fromProvider };

  if (fromYaml) {
    for (const [key, value] of Object.entries(fromYaml) as [keyof Capabilities, unknown][]) {
      if (value === undefined) continue;
      const live = fromProvider[key];
      if (live !== undefined && JSON.stringify(live) !== JSON.stringify(value)) {
        warnings.push(
          `${modelId}: models.yaml sets capabilities.${key}=${JSON.stringify(value)} but the ` +
            `provider reports ${JSON.stringify(live)}. Using the models.yaml value — ` +
            `if the provider is right, delete the override.`,
        );
      }
      // biome-ignore lint/suspicious/noExplicitAny: heterogeneous capability keys
      (merged as any)[key] = value;
    }
  }

  return { caps: merged, warnings };
}

function suggest(id: string, known: string[]): string[] {
  const stem = id
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 10);
  return known
    .filter((k) =>
      k
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .includes(stem.slice(0, 6)),
    )
    .slice(0, 5);
}

/**
 * Verify every requested model id against the provider before any billable
 * call. An unknown or retired id fails the whole run at t=0 with the id named,
 * rather than 404-ing quietly at request time.
 *
 * A provider with no API key is SKIPPED (its models are dropped with a reason),
 * never treated as a failure.
 */
export async function preflight(
  entries: ModelEntry[],
  providers: Record<ProviderName, Provider>,
): Promise<PreflightResult> {
  const skipped: { provider: ProviderName; reason: string }[] = [];
  const resolved: ResolvedModel[] = [];
  /** The id is genuinely not there — the failure mode this check exists for. */
  const unknownIds: string[] = [];
  /** We could not reach the provider to ask. A different problem, different fix. */
  const unverifiable: string[] = [];

  const byProvider = new Map<ProviderName, ModelEntry[]>();
  for (const e of entries) {
    const list = byProvider.get(e.provider) ?? [];
    list.push(e);
    byProvider.set(e.provider, list);
  }

  for (const [providerName, group] of byProvider) {
    const provider = providers[providerName];
    if (!provider.isConfigured()) {
      skipped.push({
        provider: providerName,
        reason: `${provider.envKey} not set — ${group.length} model(s) skipped: ${group
          .map((g) => g.id)
          .join(", ")}`,
      });
      continue;
    }

    let known: string[] = [];
    let listFailed: string | null = null;
    try {
      known = await provider.listModels();
    } catch (err) {
      listFailed = (err as Error).message;
    }

    for (const entry of group) {
      let info: Awaited<ReturnType<Provider["describeModel"]>> = null;
      let describeFailed: string | null = null;
      try {
        info = await provider.describeModel(entry.id);
      } catch (err) {
        describeFailed = (err as Error).message;
      }

      if (!info) {
        if (describeFailed) {
          unverifiable.push(`${entry.id} (${providerName}): could not verify — ${describeFailed}`);
          continue;
        }
        const hints = suggest(entry.id, known);
        const hintText =
          hints.length > 0
            ? ` Did you mean: ${hints.join(", ")}?`
            : listFailed
              ? ` (model list unavailable: ${listFailed})`
              : "";
        unknownIds.push(`${entry.id} (${providerName}): unknown or retired model id.${hintText}`);
        continue;
      }

      const { caps, warnings } = mergeCapabilities(info.capabilities, entry.capabilities, entry.id);
      resolved.push({
        entry,
        resolvedModel: info.resolvedModel,
        capabilities: caps,
        capabilityWarnings: warnings,
      });
    }
  }

  if (unknownIds.length > 0 || unverifiable.length > 0) {
    const parts = ["Preflight failed — no calls were made."];
    if (unknownIds.length > 0) {
      parts.push(
        `\nUnknown or retired model id(s):\n  ${unknownIds.join("\n  ")}\n` +
          `  → Fix these in models.yaml. This check exists so a retired id fails here\n` +
          `    instead of 404-ing in production.`,
      );
    }
    if (unverifiable.length > 0) {
      parts.push(
        `\nCould not reach the provider to verify:\n  ${unverifiable.join("\n  ")}\n` +
          `  → This is an auth or connectivity problem, not necessarily a bad id.\n` +
          `    Check the provider's API key in .env and your network, then retry.`,
      );
    }
    throw new PreflightError(parts.join("\n"));
  }

  return { resolved, skipped };
}
