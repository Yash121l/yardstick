import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CAPABILITIES, type Provider, RetryableProviderError } from "../providers/types.js";
import { helloSuite } from "../suites/hello.js";
import type { Suite } from "../suites/types.js";
import type {
  Attempt,
  Capabilities,
  ModelEntry,
  ProviderName,
  ProviderRequest,
  ProviderResponse,
  ResolvedModel,
  TaskSpec,
} from "../types.js";
import { ResponseCache } from "./cache.js";
import { RunWriter } from "./manifest.js";
import { runMatrix } from "./matrix.js";
import { SpendMeter } from "./spend.js";

/** Records what actually reached the wire so degradation can be asserted. */
class FakeProvider implements Provider {
  readonly name: ProviderName = "anthropic";
  readonly envKey = "ANTHROPIC_API_KEY";
  calls: ProviderRequest[] = [];

  constructor(
    private readonly behaviour: (
      req: ProviderRequest,
      caps: Capabilities,
    ) => ProviderResponse | Error,
  ) {}

  isConfigured(): boolean {
    return true;
  }
  async listModels(): Promise<string[]> {
    return ["fake"];
  }
  async describeModel(): Promise<null> {
    return null;
  }
  async complete(req: ProviderRequest, caps: Capabilities): Promise<ProviderResponse> {
    this.calls.push(req);
    const out = this.behaviour(req, caps);
    if (out instanceof Error) throw out;
    return out;
  }
}

function ok(text: string, usage = { in: 1000, out: 100 }): ProviderResponse {
  return {
    text,
    json: JSON.parse(text),
    usage,
    latencyMs: 12,
    raw: {},
    paramsDropped: [],
    stopReason: "end_turn",
  };
}

const model = (
  id: string,
  over: Partial<ModelEntry> = {},
  caps: Partial<Capabilities> = {},
): ResolvedModel => ({
  entry: {
    id,
    provider: "anthropic",
    family: "anthropic",
    priceIn: 3,
    priceOut: 15,
    priceCachedIn: null,
    baseline: false,
    roles: [],
    profile: { thinking: "default", effort: null },
    ...over,
  } as ModelEntry,
  resolvedModel: `${id}-v1`,
  capabilities: { ...DEFAULT_CAPABILITIES, ...caps },
  capabilityWarnings: [],
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yardstick-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function harness(provider: Provider) {
  return {
    anthropic: provider,
    openai: provider,
    google: provider,
    openrouter: provider,
  } as Record<ProviderName, Provider>;
}

const ctx = { root: "/tmp", fixturesVersion: "1", maxItems: null };

describe("runMatrix", () => {
  it("runs, grades, and meters cost from live usage counts", async () => {
    const provider = new FakeProvider(() => ok('{"capital":"Paris"}'));
    const spend = new SpendMeter(25);
    const out = await runMatrix({
      runId: "t1",
      suites: [helloSuite],
      models: [model("m1")],
      providers: harness(provider),
      cache: null,
      spend,
      concurrency: 2,
      repeatsOverride: null,
      repeatsCap: null,
      ctx,
      writer: new RunWriter(dir, "t1"),
    });

    expect(out.attempts).toHaveLength(1);
    expect(out.grades[0]?.status).toBe("graded");
    expect(out.grades[0]?.score).toBe(1);
    // 1000 in @ $3/MTok + 100 out @ $15/MTok
    expect(spend.total).toBeCloseTo(0.003 + 0.0015, 8);
    expect(out.errorCount).toBe(0);
  });

  it("scores a wrong answer 0 without erroring", async () => {
    const provider = new FakeProvider(() => ok('{"capital":"Lyon"}'));
    const out = await runMatrix({
      runId: "t2",
      suites: [helloSuite],
      models: [model("m1")],
      providers: harness(provider),
      cache: null,
      spend: new SpendMeter(25),
      concurrency: 2,
      repeatsOverride: null,
      repeatsCap: null,
      ctx,
      writer: new RunWriter(dir, "t2"),
    });
    expect(out.grades[0]?.score).toBe(0);
    expect(out.grades[0]?.status).toBe("graded");
  });

  it("flags a schema violation instead of crashing", async () => {
    const provider = new FakeProvider(() => ok('{"city":"Paris"}'));
    const out = await runMatrix({
      runId: "t3",
      suites: [helloSuite],
      models: [model("m1")],
      providers: harness(provider),
      cache: null,
      spend: new SpendMeter(25),
      concurrency: 2,
      repeatsOverride: null,
      repeatsCap: null,
      ctx,
      writer: new RunWriter(dir, "t3"),
    });
    expect(out.grades[0]?.score).toBe(0);
    expect(out.grades[0]?.violations[0]?.kind).toBe("schema-invalid");
  });

  it("serves the second run from cache at zero cost", async () => {
    const cachePath = join(dir, "cache.sqlite");
    const provider = new FakeProvider(() => ok('{"capital":"Paris"}'));

    const cache1 = new ResponseCache(cachePath);
    const spend1 = new SpendMeter(25);
    await runMatrix({
      runId: "c1",
      suites: [helloSuite],
      models: [model("m1")],
      providers: harness(provider),
      cache: cache1,
      spend: spend1,
      concurrency: 1,
      repeatsOverride: null,
      repeatsCap: null,
      ctx,
      writer: new RunWriter(dir, "c1"),
    });
    cache1.close();
    expect(spend1.total).toBeGreaterThan(0);
    expect(provider.calls).toHaveLength(1);

    const cache2 = new ResponseCache(cachePath);
    const spend2 = new SpendMeter(25);
    const out2 = await runMatrix({
      runId: "c2",
      suites: [helloSuite],
      models: [model("m1")],
      providers: harness(provider),
      cache: cache2,
      spend: spend2,
      concurrency: 1,
      repeatsOverride: null,
      repeatsCap: null,
      ctx,
      writer: new RunWriter(dir, "c2"),
    });
    cache2.close();

    expect(provider.calls).toHaveLength(1); // no second call
    expect(out2.cachedCount).toBe(1);
    expect(spend2.total).toBe(0);
    expect(out2.grades[0]?.score).toBe(1);
  });

  it("gives each repeat an independent sample rather than reusing the cache", async () => {
    const provider = new FakeProvider(() => ok('{"capital":"Paris"}'));
    const cache = new ResponseCache(join(dir, "r.sqlite"));
    const out = await runMatrix({
      runId: "r1",
      suites: [helloSuite],
      models: [model("m1")],
      providers: harness(provider),
      cache,
      spend: new SpendMeter(25),
      concurrency: 1,
      repeatsOverride: 3,
      repeatsCap: null,
      ctx,
      writer: new RunWriter(dir, "r1"),
    });
    cache.close();
    expect(out.attempts).toHaveLength(3);
    expect(provider.calls).toHaveLength(3);
    expect(out.cachedCount).toBe(0);
  });

  it("stops dispatching at the spend cap and reports the abort", async () => {
    const provider = new FakeProvider(() => ok('{"capital":"Paris"}', { in: 1_000_000, out: 0 }));
    const spend = new SpendMeter(0.005); // one call costs $0.003
    const out = await runMatrix({
      runId: "cap",
      suites: [helloSuite],
      models: [model("m1"), model("m2"), model("m3"), model("m4")],
      providers: harness(provider),
      cache: null,
      spend,
      concurrency: 1,
      repeatsOverride: null,
      repeatsCap: null,
      ctx,
      writer: new RunWriter(dir, "cap"),
    });
    expect(out.abortedAtCap).toBe(true);
    expect(provider.calls.length).toBeLessThan(4);
    expect(out.attempts.length).toBeLessThan(4);
  });

  it("records a failed item and lets the rest of the batch finish", async () => {
    const provider = new FakeProvider((req) =>
      req.model === "bad" ? new RetryableProviderError("503", 503) : ok('{"capital":"Paris"}'),
    );
    const out = await runMatrix({
      runId: "err",
      suites: [helloSuite],
      models: [model("bad"), model("good")],
      providers: harness(provider),
      cache: null,
      spend: new SpendMeter(25),
      concurrency: 2,
      repeatsOverride: null,
      repeatsCap: null,
      ctx,
      writer: new RunWriter(dir, "err"),
    });

    expect(out.attempts).toHaveLength(2);
    expect(out.errorCount).toBe(1);
    const bad = out.grades.find((g) => g.modelId === "bad");
    const good = out.grades.find((g) => g.modelId === "good");
    expect(bad?.status).toBe("error");
    expect(bad?.score).toBeNull();
    expect(good?.status).toBe("graded");
    expect(good?.score).toBe(1);
  });

  it("marks a refusal ungraded rather than scoring it zero", async () => {
    const provider = new FakeProvider(() => ({
      usage: { in: 10, out: 0 },
      latencyMs: 5,
      raw: {},
      paramsDropped: [],
      stopReason: "refusal",
      refusal: { kind: "content" as const, detail: "declined" },
    }));
    const out = await runMatrix({
      runId: "ref",
      suites: [helloSuite],
      models: [model("m1")],
      providers: harness(provider),
      cache: null,
      spend: new SpendMeter(25),
      concurrency: 1,
      repeatsOverride: null,
      repeatsCap: null,
      ctx,
      writer: new RunWriter(dir, "ref"),
    });
    expect(out.grades[0]?.status).toBe("ungraded");
    expect(out.grades[0]?.score).toBeNull();
    expect(out.grades[0]?.ungradedReason).toContain("declined");
  });

  it("strips temperature for a model that rejects it and still scores the item", async () => {
    // The Sonnet 5 / Opus 5 case: the suite asks for temp 0, the model cannot
    // take it, the run proceeds and the drop is on the record.
    const provider = new FakeProvider((_req, caps) => {
      expect(caps.temperature).toBe(false);
      return { ...ok('{"capital":"Paris"}'), paramsDropped: ["temperature"] };
    });
    const out = await runMatrix({
      runId: "deg",
      suites: [helloSuite],
      models: [model("no-temp", {}, { temperature: false })],
      providers: harness(provider),
      cache: null,
      spend: new SpendMeter(25),
      concurrency: 1,
      repeatsOverride: null,
      repeatsCap: null,
      ctx,
      writer: new RunWriter(dir, "deg"),
    });
    expect(out.grades[0]?.score).toBe(1);
    expect(out.attempts[0]?.response?.paramsDropped).toContain("temperature");
  });

  it("survives a grader that throws, marking the item ungraded", async () => {
    const exploding: Suite = {
      ...helloSuite,
      async grade() {
        throw new Error("grader bug");
      },
    };
    const provider = new FakeProvider(() => ok('{"capital":"Paris"}'));
    const out = await runMatrix({
      runId: "gx",
      suites: [exploding],
      models: [model("m1")],
      providers: harness(provider),
      cache: null,
      spend: new SpendMeter(25),
      concurrency: 1,
      repeatsOverride: null,
      repeatsCap: null,
      ctx,
      writer: new RunWriter(dir, "gx"),
    });
    expect(out.grades[0]?.status).toBe("ungraded");
    expect(out.grades[0]?.ungradedReason).toContain("grader bug");
  });

  it("reuses a prior run's successful attempts with --resume", async () => {
    const provider = new FakeProvider(() => ok('{"capital":"Paris"}'));
    const first = await runMatrix({
      runId: "res1",
      suites: [helloSuite],
      models: [model("m1")],
      providers: harness(provider),
      cache: null,
      spend: new SpendMeter(25),
      concurrency: 1,
      repeatsOverride: null,
      repeatsCap: null,
      ctx,
      writer: new RunWriter(dir, "res1"),
    });

    const index = new Map(first.attempts.map((a) => [a.requestHash, a]));
    const second = await runMatrix({
      runId: "res2",
      suites: [helloSuite],
      models: [model("m1")],
      providers: harness(provider),
      cache: null,
      spend: new SpendMeter(25),
      concurrency: 1,
      repeatsOverride: null,
      repeatsCap: null,
      ctx,
      writer: new RunWriter(dir, "res2"),
      resumeIndex: index,
    });

    expect(provider.calls).toHaveLength(1);
    expect(second.cachedCount).toBe(1);
    expect(second.grades[0]?.score).toBe(1);
  });
});

describe("grading does not occupy a provider slot", () => {
  /**
   * A judged suite's grader makes a SECOND API call. If that happens inside the
   * candidate's provider slot, one item holds a slot for two sequential round
   * trips: the provider sits idle while the judge thinks, and a batch takes
   * twice as long as its own concurrency limit implies.
   */
  it("issues every provider call before the first slow grade finishes", async () => {
    const CALL_MS = 5;
    const GRADE_MS = 120;
    const ITEMS = 8;
    const CONCURRENCY = 4;

    const callStarts: number[] = [];
    let firstGradeDoneAt = Number.POSITIVE_INFINITY;
    const t0 = Date.now();

    const provider = new FakeProvider(() => ok('{"answer":"ok"}'));
    const slowProvider: Provider = {
      ...provider,
      name: "anthropic",
      envKey: "ANTHROPIC_API_KEY",
      isConfigured: () => true,
      listModels: async () => ["fake"],
      describeModel: async () => null,
      async complete() {
        callStarts.push(Date.now() - t0);
        await new Promise((r) => setTimeout(r, CALL_MS));
        return ok('{"answer":"ok"}');
      },
    };

    const suite: Suite = {
      ...helloSuite,
      id: "slowgrade",
      repeats: 1,
      async loadItems() {
        return Array.from({ length: ITEMS }, (_, i) => ({
          suite: "slowgrade",
          itemId: `i${i}`,
          fixtureVersion: "1",
          prompt: { user: "hi" },
          gold: null,
          weight: 1,
        }));
      },
      async grade(spec: TaskSpec, attempt: Attempt) {
        await new Promise((r) => setTimeout(r, GRADE_MS));
        firstGradeDoneAt = Math.min(firstGradeDoneAt, Date.now() - t0);
        return {
          attemptId: attempt.attemptId,
          suite: "slowgrade",
          itemId: spec.itemId,
          modelId: attempt.modelId,
          status: "graded",
          ungradedReason: null,
          score: 1,
          subscores: {},
          perTrap: {},
          violations: [],
          evidence: [],
        };
      },
    } as unknown as Suite;

    const out = await runMatrix({
      runId: "slow",
      suites: [suite],
      models: [model("m1")],
      providers: harness(slowProvider),
      cache: null,
      spend: new SpendMeter(25),
      concurrency: CONCURRENCY,
      repeatsOverride: null,
      repeatsCap: null,
      ctx,
      writer: new RunWriter(dir, "slow"),
    });

    expect(out.attempts).toHaveLength(ITEMS);
    expect(callStarts).toHaveLength(ITEMS);
    // With grading inside the slot, only CONCURRENCY calls could have been
    // issued by the time the first grade returns; the rest wait on slots.
    expect(callStarts.every((t) => t < firstGradeDoneAt)).toBe(true);
  }, 30_000);
});
