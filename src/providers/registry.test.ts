import { describe, expect, it } from "vitest";
import type { Capabilities, ModelEntry, ProviderName } from "../types.js";
import { PreflightError, preflight } from "./registry.js";
import type { Provider, ProviderModelInfo } from "./types.js";

class FakeProvider implements Provider {
  constructor(
    readonly name: ProviderName,
    readonly envKey: string,
    private readonly configured: boolean,
    private readonly known: Record<string, Partial<Capabilities>>,
  ) {}
  isConfigured(): boolean {
    return this.configured;
  }
  async listModels(): Promise<string[]> {
    return Object.keys(this.known);
  }
  async describeModel(id: string): Promise<ProviderModelInfo | null> {
    const caps = this.known[id];
    if (!caps) return null;
    return { id, resolvedModel: `${id}-resolved`, capabilities: caps };
  }
  async complete(): Promise<never> {
    throw new Error("not used");
  }
}

const entry = (id: string, over: Partial<ModelEntry> = {}): ModelEntry =>
  ({
    id,
    provider: "anthropic",
    family: "anthropic",
    priceIn: 1,
    priceOut: 1,
    priceCachedIn: null,
    baseline: false,
    roles: [],
    profile: { thinking: "default", effort: null },
    ...over,
  }) as ModelEntry;

function providers(p: Partial<Record<ProviderName, Provider>>): Record<ProviderName, Provider> {
  return {
    anthropic: p.anthropic ?? new FakeProvider("anthropic", "ANTHROPIC_API_KEY", false, {}),
    openai: p.openai ?? new FakeProvider("openai", "OPENAI_API_KEY", false, {}),
    google: p.google ?? new FakeProvider("google", "GOOGLE_API_KEY", false, {}),
    openrouter: p.openrouter ?? new FakeProvider("openrouter", "OPENROUTER_API_KEY", false, {}),
  };
}

describe("preflight", () => {
  it("resolves a known model and records the provider version", async () => {
    const out = await preflight(
      [entry("good-model")],
      providers({
        anthropic: new FakeProvider("anthropic", "ANTHROPIC_API_KEY", true, {
          "good-model": { maxOutputTokens: 8192 },
        }),
      }),
    );
    expect(out.resolved).toHaveLength(1);
    expect(out.resolved[0]?.resolvedModel).toBe("good-model-resolved");
    expect(out.resolved[0]?.capabilities.maxOutputTokens).toBe(8192);
  });

  it("fails the whole run at t=0 on a retired id, naming it", async () => {
    // This is the failure mode that cost weeks in production.
    const p = providers({
      anthropic: new FakeProvider("anthropic", "ANTHROPIC_API_KEY", true, {
        "claude-sonnet-5": {},
      }),
    });
    await expect(preflight([entry("claude-sonnet-4-2")], p)).rejects.toThrow(PreflightError);
    await expect(preflight([entry("claude-sonnet-4-2")], p)).rejects.toThrow(
      /claude-sonnet-4-2.*unknown or retired/s,
    );
  });

  it("suggests near matches for a mistyped id", async () => {
    const p = providers({
      anthropic: new FakeProvider("anthropic", "ANTHROPIC_API_KEY", true, {
        "claude-sonnet-5": {},
      }),
    });
    await expect(preflight([entry("claude-sonnet-9")], p)).rejects.toThrow(/Did you mean/);
  });

  it("skips a provider with no key instead of failing", async () => {
    const out = await preflight([entry("anything")], providers({}));
    expect(out.resolved).toHaveLength(0);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]?.reason).toContain("ANTHROPIC_API_KEY not set");
  });

  it("lets a models.yaml override win but warns when it contradicts the API", async () => {
    const out = await preflight(
      [entry("m", { capabilities: { temperature: false } })],
      providers({
        anthropic: new FakeProvider("anthropic", "ANTHROPIC_API_KEY", true, {
          m: { temperature: true },
        }),
      }),
    );
    expect(out.resolved[0]?.capabilities.temperature).toBe(false);
    expect(out.resolved[0]?.capabilityWarnings[0]).toContain("but the provider reports");
  });

  it("does not warn when the override agrees with the API", async () => {
    const out = await preflight(
      [entry("m", { capabilities: { temperature: true } })],
      providers({
        anthropic: new FakeProvider("anthropic", "ANTHROPIC_API_KEY", true, {
          m: { temperature: true },
        }),
      }),
    );
    expect(out.resolved[0]?.capabilityWarnings).toEqual([]);
  });

  it("applies an override the provider says nothing about, silently", async () => {
    const out = await preflight(
      [entry("m", { capabilities: { temperature: false } })],
      providers({
        anthropic: new FakeProvider("anthropic", "ANTHROPIC_API_KEY", true, { m: {} }),
      }),
    );
    expect(out.resolved[0]?.capabilities.temperature).toBe(false);
    expect(out.resolved[0]?.capabilityWarnings).toEqual([]);
  });
});
