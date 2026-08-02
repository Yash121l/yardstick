import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedModel } from "../types.js";
import { loadTasks } from "./config.js";
import { runAgentic } from "./runner.js";

/**
 * The M4 gate.
 *
 * A1 grades an agent, so the thing that most needs proving is that the GRADER
 * works — that a run which solves the task scores differently from one that
 * does not, and that the compliance checks fire on an agent that misbehaves.
 *
 * Both agents here are shell scripts. No model is called and nothing is spent,
 * which is the point: a grader whose correctness can only be demonstrated by
 * spending money on a frontier model is a grader nobody re-checks.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const AGENTS = join(ROOT, "fixtures", "agents");

const model = (id: string): ResolvedModel =>
  ({
    entry: { id, provider: "anthropic", family: "anthropic", baseline: true, roles: [] },
    resolvedModel: id,
    capabilities: {},
    capabilityWarnings: [],
  }) as unknown as ResolvedModel;

/** A throwaway value, so the leak detector is exercised without a real key. */
const FIXTURE_TOKEN = `fixture-tok-${randomBytes(18).toString("hex")}`;

async function run(script: string, slugs: string[]) {
  return await runAgentic({
    root: ROOT,
    runId: "gate",
    agent: {
      invocation: join(AGENTS, script),
      timeoutMs: 120_000,
      usage: "claude-json",
      env: { YARDSTICK_ROOT: ROOT, FIXTURE_SERVICE_TOKEN: FIXTURE_TOKEN },
    },
    tasks: loadTasks(ROOT, slugs),
    models: [model("fixture-model")],
    maxSpendUsd: 10,
    dryRun: false,
    keepSandbox: false,
  });
}

// Two tasks rather than all eight: enough to prove both directions, fast enough
// that the gate stays in the ordinary test run.
const SLUGS = ["worker-cursor", "review-diff"];

describe("M4 gate — A1 grades a good and a bad agent correctly", () => {
  it("scores a competent, well-behaved agent at full marks with no violations", async () => {
    const out = await run("good-agent.sh", SLUGS);
    expect(out.grades).toHaveLength(SLUGS.length);
    for (const g of out.grades) {
      expect(g.status, `${g.itemId} should be graded`).toBe("graded");
      expect(g.score, `${g.itemId} should be solved`).toBeCloseTo(1, 6);
      expect(g.violations, `${g.itemId} should be clean`).toEqual([]);
    }
  }, 300_000);

  it("scores a misbehaving agent low AND records every compliance breach", async () => {
    const out = await run("bad-agent.sh", SLUGS);
    expect(out.grades).toHaveLength(SLUGS.length);
    for (const g of out.grades) {
      expect(g.score ?? 1, `${g.itemId} should not be solved`).toBeLessThan(0.9);
      const kinds = g.evidence.filter((e) => e.startsWith("COMPLIANCE:"));
      expect(kinds.join("\n")).toContain("git commit");
      expect(kinds.join("\n")).toContain("secret");
      expect(kinds.join("\n")).toContain("canary");
      expect(g.violations).toHaveLength(3);
    }
  }, 300_000);

  it("never writes the leaked secret value into the grade it produces", async () => {
    // Detecting a leak must not itself become one: the run record is written to
    // disk and read by whoever opens the report.
    const out = await run("bad-agent.sh", ["worker-cursor"]);
    const serialised = JSON.stringify({ grades: out.grades, attempts: out.attempts });
    expect(serialised).not.toContain(FIXTURE_TOKEN);
  }, 300_000);

  it("separates capability from compliance rather than averaging them", async () => {
    const [good, bad] = await Promise.all([
      run("good-agent.sh", ["worker-cursor"]),
      run("bad-agent.sh", ["worker-cursor"]),
    ]);
    const g = good.aggregates[0]!;
    const b = bad.aggregates[0]!;
    expect(g.metrics.score).toBeCloseTo(1, 6);
    expect(g.metrics.complianceViolations).toBe(0);
    expect(b.metrics.complianceViolations).toBe(3);
    // The compliance count is reported alongside the score, not folded into it.
    expect(b.metrics.score).toBeGreaterThan(0);
  }, 300_000);

  it("records agent cost as reported, and flags runs that reported none", async () => {
    const reported = await run("good-agent.sh", ["worker-cursor"]);
    expect(reported.costUsd).toBeCloseTo(0.0123, 6);
    expect(reported.costUnknownRuns).toBe(0);

    const silent = await runAgentic({
      root: ROOT,
      runId: "gate",
      agent: {
        invocation: join(AGENTS, "good-agent.sh"),
        timeoutMs: 120_000,
        usage: "none", // the CLI tells us nothing
        env: { YARDSTICK_ROOT: ROOT },
      },
      tasks: loadTasks(ROOT, ["worker-cursor"]),
      models: [model("fixture-model")],
      maxSpendUsd: 10,
      dryRun: false,
      keepSandbox: false,
    });
    // Unknown, never zero: a zero would clear a cost gate that never ran.
    expect(silent.costUsd).toBeNull();
    expect(silent.costUnknownRuns).toBe(1);
    expect(silent.aggregates[0]?.notes.join(" ")).toContain("UNKNOWN, not zero");
  }, 300_000);
});
