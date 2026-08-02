export interface Event {
  id: string;
  payload: unknown;
}

export interface Http {
  post(url: string, body: unknown): Promise<{ status: number }>;
}

export interface DispatchResult {
  delivered: boolean;
  attempts: number;
}

/** See ASSUMPTIONS.md: 4 attempts, exponential backoff, 5xx/429 only. */
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 100;

function retryable(status: number): boolean {
  return status >= 500 || status === 429;
}

export async function dispatch(
  http: Http,
  url: string,
  ev: Event,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<DispatchResult> {
  let attempts = 0;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    attempts++;
    const res = await http.post(url, { idempotencyKey: ev.id, payload: ev.payload });
    if (res.status >= 200 && res.status < 300) return { delivered: true, attempts };
    if (!retryable(res.status)) return { delivered: false, attempts };
    if (i < MAX_ATTEMPTS - 1) await sleep(BASE_DELAY_MS * 2 ** i * Math.random());
  }
  return { delivered: false, attempts };
}
