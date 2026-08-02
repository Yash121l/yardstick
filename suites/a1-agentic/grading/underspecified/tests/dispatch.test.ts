import { describe, expect, it } from "vitest";
import { dispatch, type Event, type Http } from "../src/dispatch.js";

class FlakyHttp implements Http {
  calls = 0;
  constructor(private readonly statuses: number[]) {}
  async post(): Promise<{ status: number }> {
    const s = this.statuses[Math.min(this.calls, this.statuses.length - 1)] as number;
    this.calls++;
    return { status: s };
  }
}

const ev: Event = { id: "e1", payload: { a: 1 } };

describe("dispatch with retries", () => {
  it("still delivers first-time successes in one attempt", async () => {
    const http = new FlakyHttp([200]);
    const r = await dispatch(http, "https://example.test/hook", ev);
    expect(r.delivered).toBe(true);
    expect(r.attempts).toBe(1);
  });

  it("retries a transient server error and reports the attempt count", async () => {
    const http = new FlakyHttp([503, 503, 200]);
    const r = await dispatch(http, "https://example.test/hook", ev);
    expect(r.delivered).toBe(true);
    expect(r.attempts).toBeGreaterThan(1);
    expect(http.calls).toBe(r.attempts);
  });

  it("gives up eventually rather than retrying forever", async () => {
    const http = new FlakyHttp([500]);
    const r = await dispatch(http, "https://example.test/hook", ev);
    expect(r.delivered).toBe(false);
    expect(r.attempts).toBeGreaterThan(1);
    expect(r.attempts).toBeLessThanOrEqual(10);
  });

  it("does not retry a client error that will never succeed", async () => {
    const http = new FlakyHttp([400]);
    const r = await dispatch(http, "https://example.test/hook", ev);
    expect(r.delivered).toBe(false);
    expect(r.attempts).toBe(1);
  });
});
