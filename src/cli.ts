import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { AgenticConfigError, loadAgentConfig, loadTasks } from "./agentic/config.js";
import { runAgentic } from "./agentic/runner.js";
import { ConfigError, JUDGE_SENTINEL, judgeIsPinned, loadConfig } from "./config.js";
import { loadEnv } from "./env.js";
import { JudgePanel, JudgeRunner } from "./graders/judge.js";
import { computeVerdicts, renderVerdicts } from "./graders/verdict.js";
import {
  PreflightError,
  buildProviders,
  mergeCapabilities,
  preflight,
} from "./providers/registry.js";
import { DEFAULT_CAPABILITIES } from "./providers/types.js";
import {
  renderAggregates,
  renderDryRun,
  renderQuirks,
  renderSummary,
  summarize,
} from "./report/cli-table.js";
import { renderHtmlReport } from "./report/html-report.js";
import { ResponseCache } from "./runner/cache.js";
import { RunWriter, gitSha, newRunId } from "./runner/manifest.js";
import { dryRun, runMatrix } from "./runner/matrix.js";
import { SpendMeter } from "./runner/spend.js";
import { resolveSuites } from "./suites/index.js";
import { startTelemetry, track } from "./telemetry.js";
import type { Attempt, ManifestModel, RunManifest } from "./types.js";

const ROOT = process.cwd();

interface Options {
  suite: string;
  models?: string;
  repeats?: string;
  maxSpend: string;
  dryRun?: boolean;
  smoke?: boolean;
  resume?: string;
  cache: boolean;
  concurrency: string;
  allowJudgeCollision?: boolean;
  dualJudge?: boolean;
  agentCli?: string;
  a1Tasks?: string;
  keepSandbox?: boolean;
  a1MaxRuns?: string;
}

function fail(message: string): never {
  process.stderr.write(`\n${message}\n\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("yardstick")
    .description("Local LLM eval harness — pin model IDs per pipeline with evidence.")
    .option("--suite <ids>", "comma-separated suite ids, or 'all'", "all")
    .option("--models <ids>", "comma-separated model ids (default: every entry in models.yaml)")
    .option("--repeats <n>", "override each suite's repeat count")
    .option("--max-spend <usd>", "hard per-run USD cap", "25")
    .option("--dry-run", "print a cost estimate and make zero calls")
    .option("--smoke", "2 items per suite, repeats capped at 3")
    .option("--resume <runId>", "reuse successful attempts from a prior run")
    .option("--no-cache", "bypass the response cache")
    .option("--concurrency <n>", "per-provider concurrency", "4")
    .option("--allow-judge-collision", "permit a same-family judge (recorded in the manifest)")
    .option("--dual-judge", "run two judges and flag disagreements above 2 rubric points")
    .option("--agent-cli <template>", "A1 only: override the agents.yaml invocation template")
    .option("--a1-tasks <slugs>", "A1 only: comma-separated task slugs (default: all)")
    .option("--keep-sandbox", "A1 only: leave each sandbox on disk for inspection")
    .option("--a1-max-runs <n>", "A1 only: hard ceiling on agent invocations")
    .parse();

  const opts = program.opts<Options>();
  loadEnv(ROOT);
  // Flags as booleans only: no suite ids, model ids or other argument values.
  startTelemetry("eval", {
    dry_run: opts.dryRun === true,
    smoke: opts.smoke === true,
    resume: opts.resume !== undefined,
    dual_judge: opts.dualJudge === true,
    cache: opts.cache,
  });

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(ROOT);
  } catch (err) {
    if (err instanceof ConfigError) fail(`Config error:\n  ${err.message}`);
    throw err;
  }

  // A1 is not a Suite: it shells out to an agent CLI instead of calling a
  // provider, so it runs on its own path and its results are merged in after.
  // It is deliberately excluded from `--suite all` — see agents.yaml for why
  // running arbitrary agent CLIs is opt-in.
  const requested = opts.suite
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const wantsA1 = requested.includes("a1");
  const suiteArg = wantsA1 ? requested.filter((x) => x !== "a1").join(",") : opts.suite;

  const { suites, unknown } =
    suiteArg === "" ? { suites: [], unknown: [] as string[] } : resolveSuites(suiteArg);
  if (unknown.length > 0) fail(`Unknown suite(s): ${unknown.join(", ")}`);
  if (suites.length === 0 && !wantsA1) {
    fail(
      `No suites selected. '--suite all' currently expands to nothing because the pipeline\n` +
        `suites land in M1-M3. Use '--suite hello' for the M0 wiring check.`,
    );
  }

  const wantedIds = opts.models
    ? opts.models
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : config.models.map((m) => m.id);
  const missing = wantedIds.filter((id) => !config.models.some((m) => m.id === id));
  if (missing.length > 0) {
    fail(
      `Not in models.yaml: ${missing.join(", ")}\n` +
        `Known ids: ${config.models.map((m) => m.id).join(", ")}`,
    );
  }
  const entries = config.models.filter((m) => wantedIds.includes(m.id));

  const judgedSuites = suites.filter((s) => s.usesJudge);
  if (judgedSuites.length > 0) {
    const judgeIds = [config.judges.primary.id, config.judges.secondary?.id].filter(
      (x): x is string => Boolean(x),
    );
    const clash = wantedIds.filter((id) => judgeIds.includes(id));
    if (clash.length > 0) {
      fail(
        `A pinned judge is also a candidate in this run: ${clash.join(", ")}.\n` +
          `A model cannot grade a suite it is competing in. Drop it from --models, or repin the judge in judges.yaml.`,
      );
    }
  }

  if (judgedSuites.length > 0 && !judgeIsPinned(config.judges.primary)) {
    fail(
      `A judged suite was requested but judges.yaml still holds the ${JUDGE_SENTINEL} placeholder.\n` +
        `Pin a real judge (from a family other than the models under test) before running P4/P5.`,
    );
  }

  const ctx = {
    root: ROOT,
    fixturesVersion: config.fixturesVersion,
    maxItems: opts.smoke ? 2 : null,
  };
  // --smoke caps repeats rather than flattening them to 1: a single sample
  // makes every cross-repeat metric (determinism, label-flip) meaningless.
  const repeatsOverride = opts.repeats ? Number.parseInt(opts.repeats, 10) : null;
  const repeatsCap = opts.smoke ? 3 : null;

  // --dry-run means ZERO calls, including the preflight model-list call. It
  // therefore works with no API keys at all, and cannot verify model ids —
  // which the output says plainly rather than implying the ids are good.
  if (opts.dryRun) {
    const unverified = entries.map((entry) => ({
      entry,
      resolvedModel: `${entry.id} (unverified)`,
      capabilities: { ...DEFAULT_CAPABILITIES, ...(entry.capabilities ?? {}) },
      capabilityWarnings: [],
    }));
    const rows =
      suites.length > 0
        ? await dryRun({ suites, models: unverified, ctx, repeatsOverride, repeatsCap })
        : [];
    if (rows.length > 0) process.stdout.write(`\n${renderDryRun(rows)}\n`);

    // A1 has no per-token estimate to give — its cost is whatever the agent CLI
    // decides to spend. Listing the plan is the honest version of a dry run.
    if (wantsA1) {
      try {
        const agentCfg = loadAgentConfig(ROOT);
        const a1Tasks = loadTasks(
          ROOT,
          opts.a1Tasks
            ?.split(",")
            .map((x) => x.trim())
            .filter(Boolean),
        );
        const runs = a1Tasks.length * unverified.length;
        process.stdout.write(
          `\na1    ${runs} agent run(s): ${a1Tasks.length} task(s) x ${unverified.length} model(s)\n` +
            `      via: ${agentCfg.invocation}\n` +
            `      worst-case wall clock ${Math.round(
              (a1Tasks.reduce((n, t) => n + Math.min(agentCfg.timeoutMs, t.task.timeoutMs), 0) *
                unverified.length) /
                60000,
            )} min if every run hits its budget\n` +
            `      cost is NOT estimated here: it is whatever the agent CLI spends, and only\n` +
            `      \`usage: claude-json\` lets the harness read it back afterwards` +
            `${agentCfg.usage === "none" ? " (currently: none)" : ""}\n`,
        );
        for (const t of a1Tasks) {
          process.stdout.write(`      - ${t.task.slug.padEnd(16)} ${t.task.title}\n`);
        }
      } catch (err) {
        if (err instanceof AgenticConfigError) fail(err.message);
        throw err;
      }
    }
    process.stdout.write(
      `\nModel ids were NOT verified against any provider (--dry-run makes zero calls).\n` +
        `A real run preflights every id first and aborts before spending if one is retired.\n\n`,
    );
    return;
  }

  const providers = buildProviders();
  let resolved: Awaited<ReturnType<typeof preflight>>;
  try {
    resolved = await preflight(entries, providers);
  } catch (err) {
    if (err instanceof PreflightError) fail(err.message);
    throw err;
  }

  for (const s of resolved.skipped) {
    process.stdout.write(`skip  ${s.provider}: ${s.reason}\n`);
  }
  for (const m of resolved.resolved) {
    for (const w of m.capabilityWarnings) process.stdout.write(`warn  ${w}\n`);
  }
  if (resolved.resolved.length === 0) {
    fail("No runnable models. Set at least one provider API key in .env.");
  }

  const runId = newRunId(new Date());
  const writer = new RunWriter(join(ROOT, "runs"), runId);
  const spend = new SpendMeter(Number.parseFloat(opts.maxSpend));
  const cache = opts.cache
    ? new ResponseCache(join(ROOT, "runs", ".cache", "responses.sqlite"))
    : null;

  const resumeIndex = opts.resume ? loadResumeIndex(join(ROOT, "runs", opts.resume)) : undefined;
  if (opts.resume) {
    process.stdout.write(`resume ${opts.resume}: ${resumeIndex?.size ?? 0} reusable attempt(s)\n`);
  }

  // Judge panel. Built after preflight so the judge shares the same cache and
  // spend meter as everything else — judge calls count against --max-spend.
  let judge: JudgePanel | null = null;
  const judgeManifest: RunManifest["judges"] = [];
  if (judgedSuites.length > 0) {
    const entries = [config.judges.primary];
    if (opts.dualJudge && config.judges.secondary) entries.push(config.judges.secondary);
    const runners: JudgeRunner[] = [];
    for (const entry of entries) {
      const provider = providers[entry.provider];
      if (!provider.isConfigured()) {
        process.stdout.write(`warn  judge ${entry.id} skipped: ${provider.envKey} not set\n`);
        continue;
      }
      let resolvedJudge = entry.id;
      let judgeInfo: Awaited<ReturnType<typeof provider.describeModel>> = null;
      try {
        judgeInfo = await provider.describeModel(entry.id);
        if (!judgeInfo)
          fail(`judges.yaml pins ${entry.id}, which ${entry.provider} does not recognise.`);
        resolvedJudge = judgeInfo.resolvedModel;
      } catch (err) {
        fail(`could not verify judge ${entry.id}: ${(err as Error).message}`);
      }
      // Judge capabilities are resolved from the provider, exactly like a
      // candidate model's. Asserting them here is how a judge silently 400s.
      //
      // A judge often also appears in models.yaml, where its quirks are already
      // recorded (`temperature: false` on Opus 4.8, say). Inherit that rather
      // than making judges.yaml a second place to remember the same fact and
      // drift from the first. An explicit block on the judge entry still wins.
      const inherited = config.models.find((m) => m.id === entry.id)?.capabilities;
      const { caps: judgeCaps, warnings: judgeWarnings } = mergeCapabilities(
        judgeInfo.capabilities,
        { ...(inherited ?? {}), ...(entry.capabilities ?? {}) },
        entry.id,
      );
      for (const w of judgeWarnings) process.stdout.write(`warn  judge ${w}\n`);
      const runner = new JudgeRunner(
        entry,
        provider,
        cache,
        spend,
        config.fixturesVersion,
        resolvedJudge,
        judgeCaps,
      );
      runners.push(runner);
      judgeManifest.push({
        id: entry.id,
        resolvedModel: resolvedJudge,
        rubricVersion: config.judges.rubricVersion,
        promptHash: runner.promptHash,
      });
    }
    if (runners.length === 0) fail("A judged suite was requested but no judge is reachable.");
    judge = new JudgePanel(runners, opts.allowJudgeCollision === true);
    process.stdout.write(
      `judge ${runners.map((r) => r.entry.id).join(" + ")}` +
        `${opts.allowJudgeCollision ? " (same-family collision ALLOWED — recorded in the manifest)" : ""}\n`,
    );
  }

  const startedAt = new Date();
  const t0 = performance.now();

  const outcome = await runMatrix({
    runId,
    suites,
    models: resolved.resolved,
    providers,
    cache,
    spend,
    concurrency: Number.parseInt(opts.concurrency, 10),
    repeatsOverride,
    repeatsCap,
    ctx,
    writer,
    resumeIndex,
    judge,
    onProgress: (ev) => {
      if (ev.kind === "retry" || ev.kind === "cap") {
        process.stdout.write(
          `${ev.kind === "cap" ? "cap  " : "retry"} ${ev.suite}/${ev.modelId}/${ev.itemId}: ${ev.message}\n`,
        );
      }
    },
  });

  // A1 runs after the provider matrix, on its own path, and merges into the
  // same attempt/grade arrays so the scoreboard, report and verdict engine see
  // one run rather than two.
  if (wantsA1) {
    const agentCfg = (() => {
      try {
        const base = loadAgentConfig(ROOT);
        return opts.agentCli ? { ...base, invocation: opts.agentCli } : base;
      } catch (err) {
        if (err instanceof AgenticConfigError) fail(err.message);
        throw err;
      }
    })();
    const a1Tasks = (() => {
      try {
        return loadTasks(
          ROOT,
          opts.a1Tasks
            ?.split(",")
            .map((x) => x.trim())
            .filter(Boolean),
        );
      } catch (err) {
        if (err instanceof AgenticConfigError) fail(err.message);
        throw err;
      }
    })();

    const a1MaxRuns = opts.a1MaxRuns ? Number.parseInt(opts.a1MaxRuns, 10) : undefined;
    process.stdout.write(
      `\na1    ${a1Tasks.length} task(s) x ${resolved.resolved.length} model(s) via: ${agentCfg.invocation.split(/\s+/)[0]}\n` +
        `      the agent CLI runs as you, with your permissions — escapes are DETECTED, not prevented\n`,
    );
    if (agentCfg.usage === "none") {
      // Saying nothing here would imply --max-spend covers A1. It cannot: the
      // harness never sees the subprocess's API calls.
      process.stdout.write(
        `      ⚠ agents.yaml sets usage: none, so this agent reports no cost and --max-spend\n` +
          `        CANNOT bind on A1. Bounded only by ${a1MaxRuns ?? a1Tasks.length * resolved.resolved.length} run(s)` +
          ` and each task's wall-clock budget.\n`,
      );
    }

    const a1 = await runAgentic({
      root: ROOT,
      runId,
      agent: agentCfg,
      tasks: a1Tasks,
      models: resolved.resolved,
      maxSpendUsd: spend.cap,
      maxRuns: a1MaxRuns,
      dryRun: false,
      keepSandbox: opts.keepSandbox === true,
      onProgress: (p) => process.stdout.write(`a1    ${p.slug}/${p.modelId}: ${p.message}\n`),
    });
    for (const a of a1.attempts) {
      outcome.attempts.push(a);
      writer.appendAttempt(a);
    }
    outcome.grades.push(...a1.grades);
    outcome.aggregates.push(...a1.aggregates);
    if (a1.costUnknownRuns > 0) {
      process.stdout.write(
        `a1    ${a1.costUnknownRuns} run(s) reported no cost; recorded as UNKNOWN, not zero\n`,
      );
    }
  }

  const manifestModels: ManifestModel[] = resolved.resolved.map((m) => ({
    id: m.entry.id,
    provider: m.entry.provider,
    resolvedModel: m.resolvedModel,
    capabilities: m.capabilities,
    profile: m.entry.profile,
    priceIn: m.entry.priceIn,
    priceOut: m.entry.priceOut,
    baseline: m.entry.baseline,
    roles: m.entry.roles,
    capabilityWarnings: m.capabilityWarnings,
  }));

  const manifest: RunManifest = {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    gitSha: gitSha(ROOT),
    fixturesVersion: config.fixturesVersion,
    cliArgs: { ...opts },
    seeds: {},
    models: manifestModels,
    judges: judgeManifest,
    skippedProviders: resolved.skipped,
    totalCostUsd: spend.total,
    wallMs: performance.now() - t0,
    abortedAtCap: outcome.abortedAtCap,
    counts: {
      attempts: outcome.attempts.length,
      cached: outcome.cachedCount,
      errors: outcome.errorCount,
      ungraded: outcome.ungradedCount,
    },
  };

  const verdicts = computeVerdicts({
    suites,
    models: resolved.resolved,
    grades: outcome.grades,
    attempts: outcome.attempts,
    aggregates: outcome.aggregates,
  });

  writer.writeManifest(manifest);
  writer.writeHtml(
    renderHtmlReport({
      manifest,
      attempts: outcome.attempts,
      grades: outcome.grades,
      aggregates: outcome.aggregates,
      verdicts,
      suiteRoles: Object.fromEntries(suites.map((s) => [s.id, s.roles as string[]])),
    }),
  );
  writer.writeResults({
    manifest,
    grades: outcome.grades,
    attempts: outcome.attempts,
    aggregates: outcome.aggregates,
    verdicts,
  });
  cache?.close();

  const cells = summarize(outcome.attempts, outcome.grades);
  process.stdout.write(`\n${renderSummary(cells, resolved.resolved)}\n`);

  const aggText = renderAggregates(outcome.aggregates);
  if (aggText) process.stdout.write(`\n${aggText}\n`);
  const quirks = renderQuirks(outcome.aggregates);
  if (quirks) process.stdout.write(`\n${quirks}\n`);

  // The coverage caveat has to land BEFORE the verdicts, not after. A reader who
  // meets "SWITCH" first and learns two screens later that it rests on 42 of 100
  // items has already formed the belief.
  if (outcome.abortedAtCap) {
    const done = new Map<string, Set<string>>();
    for (const a of outcome.attempts) {
      const k = `${a.suite} ${a.modelId}`;
      const s = done.get(k) ?? new Set<string>();
      s.add(`${a.itemId}#${a.repeatIndex}`);
      done.set(k, s);
    }
    const short = Object.entries(outcome.plannedBy)
      .map(([k, planned]) => ({ k, planned, got: done.get(k)?.size ?? 0 }))
      .filter((r) => r.got < r.planned)
      .sort((a, b) => a.k.localeCompare(b.k));
    if (short.length > 0) {
      process.stdout.write(
        `\nCOVERAGE IS PARTIAL — the spend cap stopped the matrix early.\n${short
          .map((r) => `  ${r.k}: ${r.got}/${r.planned} units`)
          .join("\n")}\n` +
          "The items that ran are the ones dispatch reached first, not a random sample,\n" +
          "so the verdicts below are provisional. Resume to a full matrix before pinning\n" +
          "anything on them.\n",
      );
    }
  }

  process.stdout.write(`\n${renderVerdicts(verdicts)}\n\n`);
  track("eval_run_completed", {
    suites: suites.length + (wantsA1 ? 1 : 0),
    models: resolved.resolved.length,
    attempts: outcome.attempts.length,
    cached: outcome.cachedCount,
    errors: outcome.errorCount,
    ungraded: outcome.ungradedCount,
    spend_usd: Math.round(spend.total * 10_000) / 10_000,
    aborted_at_cap: outcome.abortedAtCap,
  });
  process.stdout.write(
    `run ${runId}  spend $${spend.total.toFixed(4)} / $${spend.cap.toFixed(2)}  ` +
      `cached ${outcome.cachedCount}/${outcome.attempts.length}  ` +
      `errors ${outcome.errorCount}  ungraded ${outcome.ungradedCount}\n`,
  );
  if (outcome.abortedAtCap) {
    process.stdout.write(
      `\nABORTED AT SPEND CAP. Partial results are in runs/${runId}.\n` +
        (spend.total > spend.cap
          ? `Final spend is $${(spend.total - spend.cap).toFixed(4)} over the cap: the cap stops ` +
            `NEW\ndispatches, and calls already in flight are paid for when they land. Size the ` +
            `cap\nwith that headroom in mind.\n`
          : "") +
        `Resume with: npm run eval -- --resume ${runId} --max-spend <higher>\n`,
    );
  }
  process.stdout.write(
    `results: runs/${runId}/results.json\n` + `report:  runs/${runId}/report.html\n`,
  );
}

function loadResumeIndex(dir: string): Map<string, Attempt> {
  const path = join(dir, "attempts.jsonl");
  const index = new Map<string, Attempt>();
  if (!existsSync(path)) {
    process.stderr.write(`warn  --resume: no attempts.jsonl in ${dir}; starting fresh\n`);
    return index;
  }
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const a = JSON.parse(line) as Attempt;
      if (a.response && !a.error) index.set(a.requestHash, a);
    } catch {
      // A truncated final line from an aborted run is expected; skip it.
    }
  }
  return index;
}

main().catch((err) => {
  process.stderr.write(`\nUnexpected failure: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
