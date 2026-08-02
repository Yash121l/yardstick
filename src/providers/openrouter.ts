import type { Capabilities } from "../types.js";
import { httpJson, parseJson, raiseForStatus } from "./http.js";
import { OpenAICompatibleProvider } from "./openai.js";
import type { ProviderModelInfo } from "./types.js";

export interface OpenRouterPricing {
  id: string;
  /** USD per million tokens. */
  priceIn: number;
  priceOut: number;
}

interface OpenRouterModel {
  id?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[] };
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
  top_provider?: { max_completion_tokens?: number | null };
}

/**
 * OpenRouter speaks the OpenAI chat-completions shape, so only the transport
 * details differ. Its model list is unusually good for our purposes: it carries
 * live per-token pricing AND a `supported_parameters` array, which lets
 * preflight resolve `temperature` / `stop` / `jsonSchema` support for real
 * instead of trusting a hand-maintained flag.
 */
export class OpenRouterProvider extends OpenAICompatibleProvider {
  override readonly name = "openrouter" as const;
  override readonly envKey = "OPENROUTER_API_KEY";
  protected override base = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
  protected override maxTokensField = "max_tokens" as const;

  private cache: Map<string, OpenRouterModel> | null = null;

  private async index(): Promise<Map<string, OpenRouterModel>> {
    if (this.cache) return this.cache;
    const res = await httpJson(`${this.base}/models`, { method: "GET", headers: this.headers() });
    if (res.status !== 200) raiseForStatus(res.status, res.body, "openrouter listModels");
    const parsed = parseJson(res.body, "openrouter listModels") as { data?: OpenRouterModel[] };
    const map = new Map<string, OpenRouterModel>();
    for (const m of parsed.data ?? []) if (m.id) map.set(m.id, m);
    this.cache = map;
    return map;
  }

  override async listModels(): Promise<string[]> {
    return [...(await this.index()).keys()];
  }

  override async describeModel(id: string): Promise<ProviderModelInfo | null> {
    const m = (await this.index()).get(id);
    if (!m) return null;

    const partial: Partial<Capabilities> = {
      maxInputTokens: m.context_length ?? null,
      maxOutputTokens: m.top_provider?.max_completion_tokens ?? null,
    };

    const params = m.supported_parameters;
    if (params) {
      partial.temperature = params.includes("temperature");
      partial.stopSequences = params.includes("stop");
      partial.jsonSchema =
        params.includes("response_format") || params.includes("structured_outputs");
      partial.toolUse = params.includes("tools");
      if (params.includes("reasoning") || params.includes("include_reasoning")) {
        partial.thinkingModes = ["off", "adaptive"];
      }
    }

    const modalities = m.architecture?.input_modalities;
    if (modalities) partial.images = modalities.includes("image");

    return { id, resolvedModel: id, capabilities: partial };
  }

  /** Live pricing for `npm run prices:sync`. USD per million tokens. */
  async fetchPricing(): Promise<OpenRouterPricing[]> {
    const out: OpenRouterPricing[] = [];
    for (const [id, m] of await this.index()) {
      const p = Number.parseFloat(m.pricing?.prompt ?? "");
      const c = Number.parseFloat(m.pricing?.completion ?? "");
      if (!Number.isFinite(p) || !Number.isFinite(c)) continue;
      out.push({ id, priceIn: p * 1_000_000, priceOut: c * 1_000_000 });
    }
    return out;
  }
}
