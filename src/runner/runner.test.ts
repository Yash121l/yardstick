import { describe, expect, it, vi } from "vitest";
import { FatalProviderError, RetryableProviderError } from "../providers/types.js";
import { costOf, totalInputTokens } from "../types.js";
import { cacheKey, stableStringify } from "./cache.js";
import { Semaphore } from "./concurrency.js";
import { withRetry } from "./retry.js";
import { SpendMeter } from "./spend.js";

describe("stableStringify", () => {
  it("is insensitive to key order", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it("is sensitive to values", () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });

  it("preserves array order", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it("drops undefined members so an absent key and an undefined key agree", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });
});

describe("cacheKey", () => {
  const base = {
    modelId: "m",
    resolvedModel: "m-2026",
    request: { model: "m", messages: [{ role: "user" as const, content: "hi" }] },
    fixturesVersion: "1",
    repeatIndex: 0,
  };

  it("is stable for identical inputs", () => {
    expect(cacheKey(base)).toBe(cacheKey({ ...base }));
  });

  it("changes with the repeat index so repeats are independent samples", () => {
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, repeatIndex: 1 }));
  });

  it("changes with the fixtures version so scores never cross a regen", () => {
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, fixturesVersion: "2" }));
  });

  it("changes with the resolved model version", () => {
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, resolvedModel: "m-2027" }));
  });
});

describe("SpendMeter", () => {
  it("permits work under the cap", () => {
    const m = new SpendMeter(1);
    expect(m.reserve()).toBe(true);
    m.add(0.5);
    expect(m.reserve()).toBe(true);
  });

  it("refuses to dispatch once the cap is reached", () => {
    const m = new SpendMeter(1);
    m.add(1.0);
    expect(m.reserve()).toBe(false);
    expect(m.isAborted).toBe(true);
  });

  it("aborts when a single call crosses the cap", () => {
    const m = new SpendMeter(0.01);
    expect(m.reserve()).toBe(true);
    m.add(5);
    expect(m.isAborted).toBe(true);
    expect(m.total).toBe(5);
  });
});

describe("withRetry", () => {
  const nosleep = async () => {};

  it("returns the value on first success", async () => {
    const out = await withRetry(async () => 42, { sleep: nosleep });
    expect(out.value).toBe(42);
    expect(out.attempts).toBe(1);
  });

  it("retries a retryable error twice then records it", async () => {
    const fn = vi.fn(async () => {
      throw new RetryableProviderError("503", 503);
    });
    const out = await withRetry(fn, { sleep: nosleep });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(out.value).toBeNull();
    expect(out.error).toBeInstanceOf(RetryableProviderError);
    expect(out.attempts).toBe(3);
  });

  it("succeeds on a later attempt", async () => {
    let n = 0;
    const out = await withRetry(
      async () => {
        n++;
        if (n < 3) throw new RetryableProviderError("503", 503);
        return "ok";
      },
      { sleep: nosleep },
    );
    expect(out.value).toBe("ok");
    expect(out.attempts).toBe(3);
  });

  it("does not retry a fatal error", async () => {
    const fn = vi.fn(async () => {
      throw new FatalProviderError("401", 401);
    });
    const out = await withRetry(fn, { sleep: nosleep });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(out.error).toBeInstanceOf(FatalProviderError);
  });
});

describe("Semaphore", () => {
  it("never exceeds its limit", async () => {
    const s = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        s.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(active).toBe(0);
  });

  it("releases on throw", async () => {
    const s = new Semaphore(1);
    await expect(
      s.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(s.run(async () => "ok")).resolves.toBe("ok");
  });
});

describe("costOf", () => {
  it("prices input and output separately", () => {
    // 1M in at $3, 1M out at $15
    expect(costOf({ in: 1_000_000, out: 1_000_000 }, 3, 15)).toBeCloseTo(18, 6);
  });

  it("discounts cache reads at the default 0.1x when no cached rate is given", () => {
    expect(costOf({ in: 0, out: 0, cachedIn: 1_000_000 }, 3, 15)).toBeCloseTo(0.3, 6);
  });

  it("uses an explicit cached rate when the registry supplies one", () => {
    expect(costOf({ in: 0, out: 0, cachedIn: 1_000_000 }, 3, 15, 0.6)).toBeCloseTo(0.6, 6);
  });

  it("charges cache WRITES at a premium, not for free", () => {
    // Writing a cache costs ~1.25x uncached input. Ignoring this bucket
    // under-reports the cost of any run that populates a cache.
    expect(costOf({ in: 0, out: 0, cacheWriteIn: 1_000_000 }, 4, 0)).toBeCloseTo(5, 6);
  });

  it("treats the three input buckets as disjoint and sums them", () => {
    // 600k uncached @ $10, 400k read @ $1, 200k written @ $12.50
    const c = costOf({ in: 600_000, out: 0, cachedIn: 400_000, cacheWriteIn: 200_000 }, 10, 0);
    expect(c).toBeCloseTo(6 + 0.4 + 2.5, 6);
  });

  it("counts every bucket toward the total prompt size", () => {
    expect(totalInputTokens({ in: 10, out: 0, cachedIn: 20, cacheWriteIn: 30 })).toBe(60);
    expect(totalInputTokens({ in: 10, out: 0 })).toBe(10);
  });
});
