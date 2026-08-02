import { RetryableProviderError } from "../providers/types.js";

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, err: Error, delayMs: number) => void;
}

export const DEFAULT_RETRY: RetryOptions = {
  retries: 2,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface RetryOutcome<T> {
  value: T | null;
  error: Error | null;
  attempts: number;
}

/**
 * Retries transport/429/5xx failures only. A structured refusal is data, not an
 * error, so it never reaches this path. One item's failure is recorded and the
 * batch continues — it is never allowed to abort the run.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<RetryOutcome<T>> {
  const o = { ...DEFAULT_RETRY, ...opts };
  const sleep = o.sleep ?? defaultSleep;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= o.retries + 1; attempt++) {
    try {
      return { value: await fn(), error: null, attempts: attempt };
    } catch (err) {
      const e = err as Error;
      lastError = e;
      const retryable = e instanceof RetryableProviderError;
      if (!retryable || attempt === o.retries + 1) {
        return { value: null, error: e, attempts: attempt };
      }
      const explicit = e instanceof RetryableProviderError ? e.retryAfterMs : null;
      const backoff = Math.min(o.baseDelayMs * 2 ** (attempt - 1), o.maxDelayMs);
      const jitter = Math.floor(backoff * 0.25 * Math.random());
      const delay = explicit ?? backoff + jitter;
      o.onRetry?.(attempt, e, delay);
      await sleep(delay);
    }
  }

  return { value: null, error: lastError, attempts: o.retries + 1 };
}
