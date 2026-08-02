import type { Capabilities, ProviderRequest, ProviderResponse } from "../types.js";
import { extractJson, httpJson, parseJson, raiseForStatus } from "./http.js";
import { type Provider, type ProviderModelInfo, classifyError, degradeRequest } from "./types.js";

const BASE = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const VERSION = "2023-06-01";

interface AnthropicCapabilityNode {
  supported?: boolean;
  types?: Record<string, AnthropicCapabilityNode>;
  [k: string]: unknown;
}

function supported(node: unknown): boolean | undefined {
  if (node && typeof node === "object" && "supported" in node) {
    const v = (node as AnthropicCapabilityNode).supported;
    return typeof v === "boolean" ? v : undefined;
  }
  return undefined;
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic" as const;
  readonly envKey = "ANTHROPIC_API_KEY";

  isConfigured(): boolean {
    return Boolean(process.env[this.envKey]);
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-api-key": process.env[this.envKey] ?? "",
      "anthropic-version": VERSION,
    };
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = [];
    let afterId: string | undefined;
    // Stop condition is "this call did zero work", never a page counter.
    for (;;) {
      const url = new URL(`${BASE}/v1/models`);
      url.searchParams.set("limit", "100");
      if (afterId) url.searchParams.set("after_id", afterId);
      const res = await httpJson(url.toString(), { method: "GET", headers: this.headers() });
      if (res.status !== 200) raiseForStatus(res.status, res.body, "anthropic listModels");
      const parsed = parseJson(res.body, "anthropic listModels") as {
        data?: { id?: string }[];
        has_more?: boolean;
        last_id?: string;
      };
      const page = (parsed.data ?? []).map((m) => m.id).filter((x): x is string => Boolean(x));
      if (page.length === 0) break;
      ids.push(...page);
      if (!parsed.has_more || !parsed.last_id) break;
      afterId = parsed.last_id;
    }
    return ids;
  }

  async describeModel(id: string): Promise<ProviderModelInfo | null> {
    const res = await httpJson(`${BASE}/v1/models/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (res.status !== 200) raiseForStatus(res.status, res.body, `anthropic describeModel(${id})`);

    const m = parseJson(res.body, "anthropic describeModel") as {
      id?: string;
      max_input_tokens?: number;
      max_tokens?: number;
      capabilities?: Record<string, AnthropicCapabilityNode>;
    };
    const caps = m.capabilities ?? {};
    const thinkingTypes = caps.thinking?.types ?? {};
    const thinkingModes: Capabilities["thinkingModes"] = [];
    if (supported(thinkingTypes.disabled) !== false) thinkingModes.push("off");
    if (supported(thinkingTypes.adaptive)) thinkingModes.push("adaptive");

    const effortLevels: string[] = [];
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      if (supported(caps.effort?.[level])) effortLevels.push(level);
    }

    const partial: Partial<Capabilities> = {
      maxInputTokens: m.max_input_tokens ?? null,
      maxOutputTokens: m.max_tokens ?? null,
    };
    const img = supported(caps.image_input);
    if (img !== undefined) partial.images = img;
    const so = supported(caps.structured_outputs);
    if (so !== undefined) partial.jsonSchema = so;
    if (thinkingModes.length > 0) partial.thinkingModes = thinkingModes;
    if (effortLevels.length > 0) partial.effortLevels = effortLevels;

    return { id, resolvedModel: m.id ?? id, capabilities: partial };
  }

  async complete(req: ProviderRequest, caps: Capabilities): Promise<ProviderResponse> {
    const d = degradeRequest(req, caps);

    const content: unknown[] = [];
    for (const img of d.images ?? []) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.mime, data: img.b64 },
      });
    }

    const messages = req.messages.map((m, i) => {
      if (i === req.messages.length - 1 && m.role === "user" && content.length > 0) {
        return { role: m.role, content: [...content, { type: "text", text: m.content }] };
      }
      return { role: m.role, content: m.content };
    });

    const outputConfig: Record<string, unknown> = {};
    if (d.jsonSchema) outputConfig.format = { type: "json_schema", schema: d.jsonSchema };
    if (d.effort) outputConfig.effort = d.effort;

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: d.maxTokens ?? 4096,
      messages,
    };
    if (req.system) body.system = req.system;
    if (d.temperature !== undefined) body.temperature = d.temperature;
    if (d.stop) body.stop_sequences = d.stop;
    if (d.thinking === "disabled") body.thinking = { type: "disabled" };
    else if (d.thinking === "adaptive") body.thinking = { type: "adaptive" };
    if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig;
    // Top-level auto-caching: places the breakpoint on the last cacheable block.
    if (req.cacheable) {
      body.cache_control =
        req.cacheTtl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
    }

    const res = await httpJson(`${BASE}/v1/messages`, {
      method: "POST",
      headers: this.headers(),
      body,
    });

    if (res.status !== 200) {
      const refusal = classifyError(res.status, res.body);
      if (refusal) {
        return {
          usage: { in: 0, out: 0 },
          latencyMs: res.latencyMs,
          raw: res.body,
          refusal,
          paramsDropped: d.paramsDropped,
          stopReason: null,
        };
      }
      raiseForStatus(res.status, res.body, "anthropic messages");
    }

    const msg = parseJson(res.body, "anthropic messages") as {
      content?: { type?: string; text?: string }[];
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      stop_reason?: string;
      stop_details?: { category?: string; explanation?: string };
    };

    const text = (msg.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");

    const out: ProviderResponse = {
      text,
      // Anthropic's input_tokens is ALREADY exclusive of cache reads and
      // writes, so the three buckets pass through unchanged.
      usage: {
        in: msg.usage?.input_tokens ?? 0,
        out: msg.usage?.output_tokens ?? 0,
        ...(msg.usage?.cache_read_input_tokens !== undefined
          ? { cachedIn: msg.usage.cache_read_input_tokens }
          : {}),
        ...(msg.usage?.cache_creation_input_tokens !== undefined
          ? {
              cacheWriteIn: msg.usage.cache_creation_input_tokens,
              cacheWriteLongTtl: req.cacheTtl === "1h",
            }
          : {}),
      },
      latencyMs: res.latencyMs,
      raw: msg,
      paramsDropped: d.paramsDropped,
      stopReason: msg.stop_reason ?? null,
    };

    // A safety decline is a content refusal, not an error. Opus 5 / Sonnet 5 /
    // Fable 5 return HTTP 200 with stop_reason "refusal".
    if (msg.stop_reason === "refusal") {
      out.refusal = {
        kind: "content",
        detail: msg.stop_details?.category
          ? `${msg.stop_details.category}: ${msg.stop_details.explanation ?? ""}`.trim()
          : "declined",
      };
    }

    const json = extractJson(text);
    if (json !== undefined) out.json = json;
    return out;
  }
}
