import type { Capabilities, ProviderRequest, ProviderResponse } from "../types.js";
import { extractJson, httpJson, parseJson, raiseForStatus } from "./http.js";
import { type Provider, type ProviderModelInfo, classifyError, degradeRequest } from "./types.js";

const BASE = process.env.GOOGLE_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta";

/** Google prefixes ids with `models/` in its listing; accept either form. */
function bare(id: string): string {
  return id.startsWith("models/") ? id.slice("models/".length) : id;
}

export class GoogleProvider implements Provider {
  readonly name = "google" as const;
  readonly envKey = "GOOGLE_API_KEY";

  isConfigured(): boolean {
    return Boolean(process.env[this.envKey]);
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-goog-api-key": process.env[this.envKey] ?? "",
    };
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    for (;;) {
      const url = new URL(`${BASE}/models`);
      url.searchParams.set("pageSize", "200");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const res = await httpJson(url.toString(), { method: "GET", headers: this.headers() });
      if (res.status !== 200) raiseForStatus(res.status, res.body, "google listModels");
      const parsed = parseJson(res.body, "google listModels") as {
        models?: { name?: string }[];
        nextPageToken?: string;
      };
      const page = (parsed.models ?? []).map((m) => m.name).filter((x): x is string => Boolean(x));
      if (page.length === 0) break;
      ids.push(...page.map(bare));
      if (!parsed.nextPageToken) break;
      pageToken = parsed.nextPageToken;
    }
    return ids;
  }

  async describeModel(id: string): Promise<ProviderModelInfo | null> {
    const res = await httpJson(`${BASE}/models/${encodeURIComponent(bare(id))}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (res.status !== 200) raiseForStatus(res.status, res.body, `google describeModel(${id})`);
    const m = parseJson(res.body, "google describeModel") as {
      name?: string;
      version?: string;
      inputTokenLimit?: number;
      outputTokenLimit?: number;
    };
    const partial: Partial<Capabilities> = {
      maxInputTokens: m.inputTokenLimit ?? null,
      maxOutputTokens: m.outputTokenLimit ?? null,
    };
    const resolved = m.version ? `${bare(m.name ?? id)}@${m.version}` : bare(m.name ?? id);
    return { id, resolvedModel: resolved, capabilities: partial };
  }

  async complete(req: ProviderRequest, caps: Capabilities): Promise<ProviderResponse> {
    const d = degradeRequest(req, caps);

    const contents = req.messages.map((m, i) => {
      const parts: Record<string, unknown>[] = [];
      if (i === req.messages.length - 1 && m.role === "user") {
        for (const img of d.images ?? []) {
          parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
        }
      }
      parts.push({ text: m.content });
      return { role: m.role === "assistant" ? "model" : "user", parts };
    });

    const generationConfig: Record<string, unknown> = {};
    if (d.maxTokens !== undefined) generationConfig.maxOutputTokens = d.maxTokens;
    if (d.temperature !== undefined) generationConfig.temperature = d.temperature;
    if (d.stop) generationConfig.stopSequences = d.stop;
    if (d.jsonSchema) {
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseSchema = d.jsonSchema;
    }
    if (d.thinking === "disabled") generationConfig.thinkingConfig = { thinkingBudget: 0 };

    const body: Record<string, unknown> = { contents };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

    const res = await httpJson(
      `${BASE}/models/${encodeURIComponent(bare(req.model))}:generateContent`,
      { method: "POST", headers: this.headers(), body },
    );

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
      raiseForStatus(res.status, res.body, "google generateContent");
    }

    const parsed = parseJson(res.body, "google generateContent") as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        cachedContentTokenCount?: number;
      };
      promptFeedback?: { blockReason?: string };
    };

    const cand = parsed.candidates?.[0];
    const text = (cand?.content?.parts ?? [])
      .map((p) => p.text)
      .filter((t): t is string => typeof t === "string")
      .join("");
    // Google's promptTokenCount INCLUDES cached content, so subtract for the
    // disjoint buckets Usage promises.
    const cached = parsed.usageMetadata?.cachedContentTokenCount;
    const prompt = parsed.usageMetadata?.promptTokenCount ?? 0;

    const out: ProviderResponse = {
      text,
      usage: {
        in: Math.max(0, prompt - (cached ?? 0)),
        out: parsed.usageMetadata?.candidatesTokenCount ?? 0,
        ...(cached !== undefined ? { cachedIn: cached } : {}),
      },
      latencyMs: res.latencyMs,
      raw: parsed,
      paramsDropped: d.paramsDropped,
      stopReason: cand?.finishReason ?? null,
    };

    if (parsed.promptFeedback?.blockReason) {
      out.refusal = { kind: "content", detail: parsed.promptFeedback.blockReason };
    } else if (cand?.finishReason === "SAFETY") {
      out.refusal = { kind: "content", detail: "SAFETY" };
    }

    const json = extractJson(text);
    if (json !== undefined) out.json = json;
    return out;
  }
}
