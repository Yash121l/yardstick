import type { Capabilities, ProviderRequest, ProviderResponse } from "../types.js";
import { extractJson, httpJson, parseJson, raiseForStatus } from "./http.js";
import { type Provider, type ProviderModelInfo, classifyError, degradeRequest } from "./types.js";

/**
 * OpenAI-compatible chat-completions adapter. `OpenRouterProvider` subclasses
 * this because the request shape is the same; only the base URL, auth header,
 * output-cap field name, and the model-list payload differ.
 */
export class OpenAICompatibleProvider implements Provider {
  readonly name: "openai" | "openrouter" = "openai";
  readonly envKey: string = "OPENAI_API_KEY";
  protected base: string = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  /** Newer OpenAI models require `max_completion_tokens`; OpenRouter uses `max_tokens`. */
  protected maxTokensField: "max_tokens" | "max_completion_tokens" = "max_completion_tokens";

  isConfigured(): boolean {
    return Boolean(process.env[this.envKey]);
  }

  protected headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${process.env[this.envKey] ?? ""}`,
    };
  }

  async listModels(): Promise<string[]> {
    const res = await httpJson(`${this.base}/models`, { method: "GET", headers: this.headers() });
    if (res.status !== 200) raiseForStatus(res.status, res.body, `${this.name} listModels`);
    const parsed = parseJson(res.body, `${this.name} listModels`) as { data?: { id?: string }[] };
    return (parsed.data ?? []).map((m) => m.id).filter((x): x is string => Boolean(x));
  }

  async describeModel(id: string): Promise<ProviderModelInfo | null> {
    const res = await httpJson(`${this.base}/models/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (res.status !== 200)
      raiseForStatus(res.status, res.body, `${this.name} describeModel(${id})`);
    const m = parseJson(res.body, `${this.name} describeModel`) as { id?: string };
    // OpenAI's model object carries no capability tree; models.yaml owns those.
    return { id, resolvedModel: m.id ?? id, capabilities: {} };
  }

  async complete(req: ProviderRequest, caps: Capabilities): Promise<ProviderResponse> {
    const d = degradeRequest(req, caps);

    const messages: Record<string, unknown>[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    req.messages.forEach((m, i) => {
      const isLastUser = i === req.messages.length - 1 && m.role === "user";
      if (isLastUser && d.images && d.images.length > 0) {
        messages.push({
          role: m.role,
          content: [
            ...d.images.map((img) => ({
              type: "image_url",
              image_url: { url: `data:${img.mime};base64,${img.b64}` },
            })),
            { type: "text", text: m.content },
          ],
        });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    });

    const body: Record<string, unknown> = { model: req.model, messages };
    if (d.maxTokens !== undefined) body[this.maxTokensField] = d.maxTokens;
    if (d.temperature !== undefined) body.temperature = d.temperature;
    if (d.stop) body.stop = d.stop;
    if (d.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "yardstick_output", strict: true, schema: d.jsonSchema },
      };
    }
    if (d.effort) body.reasoning_effort = d.effort;

    const res = await httpJson(`${this.base}/chat/completions`, {
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
      raiseForStatus(res.status, res.body, `${this.name} chat/completions`);
    }

    const parsed = parseJson(res.body, `${this.name} chat/completions`) as {
      choices?: {
        message?: { content?: string | null; refusal?: string | null };
        finish_reason?: string;
      }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };

    const choice = parsed.choices?.[0];
    const text = choice?.message?.content ?? "";
    // OpenAI's prompt_tokens INCLUDES cached tokens, so subtract to get the
    // disjoint buckets Usage promises.
    const cached = parsed.usage?.prompt_tokens_details?.cached_tokens;
    const prompt = parsed.usage?.prompt_tokens ?? 0;

    const out: ProviderResponse = {
      text,
      usage: {
        in: Math.max(0, prompt - (cached ?? 0)),
        out: parsed.usage?.completion_tokens ?? 0,
        ...(cached !== undefined ? { cachedIn: cached } : {}),
      },
      latencyMs: res.latencyMs,
      raw: parsed,
      paramsDropped: d.paramsDropped,
      stopReason: choice?.finish_reason ?? null,
    };

    if (choice?.message?.refusal) {
      out.refusal = { kind: "content", detail: choice.message.refusal };
    }

    const json = extractJson(text);
    if (json !== undefined) out.json = json;
    return out;
  }
}

export class OpenAIProvider extends OpenAICompatibleProvider {}
