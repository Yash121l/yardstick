import { FatalProviderError, RetryableProviderError, truncate } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface HttpResult {
  status: number;
  body: string;
  latencyMs: number;
}

/**
 * Single place every provider call goes through.
 *
 * Headers are never echoed into an error message or a return value — the only
 * things that escape this function are the status, the response body, and a
 * latency. Key material has no path to a log line.
 */
export async function httpJson(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: unknown; timeoutMs?: number },
): Promise<HttpResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    const body = await res.text();
    return { status: res.status, body, latencyMs: performance.now() - started };
  } catch (err) {
    const e = err as Error;
    if (e.name === "AbortError") {
      throw new RetryableProviderError(
        `request timed out after ${init.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
        null,
      );
    }
    throw new RetryableProviderError(`network error: ${e.message}`, null);
  } finally {
    clearTimeout(timeout);
  }
}

/** Turn a non-2xx into the right exception class. Refusals are handled upstream. */
export function raiseForStatus(status: number, body: string, ctx: string): never {
  if (status === 429) {
    throw new RetryableProviderError(`${ctx}: rate limited`, 429, parseRetryAfter(body));
  }
  if (status >= 500) {
    throw new RetryableProviderError(
      `${ctx}: server error ${status}: ${truncate(body, 300)}`,
      status,
    );
  }
  throw new FatalProviderError(`${ctx}: HTTP ${status}: ${truncate(body, 300)}`, status);
}

function parseRetryAfter(body: string): number | null {
  const m = /retry[- ]after["':\s]+(\d+)/i.exec(body);
  if (!m?.[1]) return null;
  return Number.parseInt(m[1], 10) * 1000;
}

export function parseJson(body: string, ctx: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new FatalProviderError(`${ctx}: response was not JSON: ${truncate(body, 300)}`, null);
  }
}

/** Extract the first fenced or bare JSON object from model text output. */
export function extractJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Fall back to the first balanced {...} span.
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) return undefined;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}
