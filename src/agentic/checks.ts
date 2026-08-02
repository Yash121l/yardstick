import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "./sandbox.js";
import type { Check, PlantedDefect } from "./types.js";

/**
 * One graded assertion.
 *
 * `score: null` means the check could not be run at all — a missing
 * interpreter, an unparseable reporter payload. It is never rendered as 0,
 * because "the agent failed" and "we could not tell" are different claims and
 * averaging them together is how a broken harness reports a model regression.
 */
export interface CheckResult {
  label: string;
  kind: Check["kind"];
  score: number | null;
  ungradedReason: string | null;
  weight: number;
  detail: string;
  evidence: string[];
}

const VITEST_BIN = new URL("../../node_modules/.bin/vitest", import.meta.url).pathname;

function ok(c: Check, score: number, detail: string, evidence: string[] = []): CheckResult {
  return {
    label: c.label,
    kind: c.kind,
    score,
    ungradedReason: null,
    weight: c.weight,
    detail,
    evidence,
  };
}

function cannotGrade(c: Check, reason: string): CheckResult {
  return {
    label: c.label,
    kind: c.kind,
    score: null,
    ungradedReason: reason,
    weight: c.weight,
    detail: reason,
    evidence: [],
  };
}

/** Vitest's JSON reporter prints a banner before the payload on some paths. */
function parseTrailingJson(text: string): unknown | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  for (let i = start; i >= 0; i = text.indexOf("{", i + 1)) {
    try {
      return JSON.parse(text.slice(i));
    } catch {
      /* try the next brace */
    }
  }
  return null;
}

async function runVitest(c: Extract<Check, { kind: "vitest" }>, dir: string): Promise<CheckResult> {
  if (!existsSync(join(dir, c.testDir))) {
    return cannotGrade(c, `hidden test directory ${c.testDir} was not installed`);
  }
  // The trailing positional is a path substring filter. Without it vitest
  // collects every test in the sandbox, INCLUDING any the agent wrote — a
  // trivial passing test it adds would otherwise raise its own score.
  const r = await runCommand([VITEST_BIN, "run", "--root", dir, "--reporter=json", c.testDir], {
    cwd: dir,
    timeoutMs: c.timeoutMs,
  });
  if (r.timedOut) return cannotGrade(c, `hidden tests timed out after ${c.timeoutMs}ms`);

  const payload = parseTrailingJson(r.stdout) as {
    numTotalTests?: number;
    numPassedTests?: number;
    testResults?: Array<{ name?: unknown }>;
  } | null;
  if (!payload || typeof payload.numTotalTests !== "number") {
    // A crashed runner is not a failing agent. Say so.
    return cannotGrade(
      c,
      `vitest produced no parseable report (exit ${r.exitCode}); ${r.stderr.slice(0, 200).trim()}`,
    );
  }

  // The filter is a substring match, so `src/hidden-tests-mine.test.ts` would
  // slip through it. Verify every file actually reported on lives under the
  // installed hidden directory before trusting the counts.
  const hiddenRoot = join(dir, c.testDir);
  const foreign = (payload.testResults ?? [])
    .map((t) => (typeof t.name === "string" ? t.name : ""))
    .filter((n) => n && !n.startsWith(`${hiddenRoot}/`));
  if (foreign.length > 0) {
    return cannotGrade(
      c,
      `refusing to score: ${foreign.length} test file(s) outside the hidden suite were collected ` +
        `(${foreign.map((f) => f.replace(`${dir}/`, "")).join(", ")}). Tests the agent wrote cannot count toward its own grade.`,
    );
  }

  const total = payload.numTotalTests;
  const passed = payload.numPassedTests ?? 0;
  if (total === 0) return cannotGrade(c, "hidden test suite contained no tests");
  return ok(c, passed / total, `${passed}/${total} hidden tests pass`);
}

/** Negation cues that turn "race condition" into a ruled-out alternative. */
const NEGATION =
  /\b(not|isn't|is not|wasn't|was not|no|never|rule[sd]? out|ruling out|rather than|instead of|unlikely|discount(?:ed)?|eliminat(?:e|ed)|why not|considered and rejected)\b/i;

/**
 * Does the document assert `term` as the cause, or merely mention it?
 *
 * A good RCA names the cause AND says why the obvious alternatives are wrong.
 * A plain substring test punishes exactly that: a write-up containing "this is
 * not a race condition" would be scored as having diagnosed a race condition.
 * So an occurrence is ignored when its own line, or the heading it sits under,
 * carries a negation.
 */
export function assertsCause(doc: string, term: string): boolean {
  const needle = term.toLowerCase();
  const lines = doc.split(/\r?\n/);
  let heading = "";
  for (const line of lines) {
    if (/^\s*#{1,6}\s/.test(line)) heading = line;
    if (!line.toLowerCase().includes(needle)) continue;
    if (NEGATION.test(line) || NEGATION.test(heading)) continue;
    return true;
  }
  return false;
}

async function runFileKeywords(
  c: Extract<Check, { kind: "file-keywords" }>,
  dir: string,
): Promise<CheckResult> {
  const p = join(dir, c.path);
  if (!existsSync(p)) return ok(c, 0, `${c.path} was never written`);
  const raw = readFileSync(p, "utf8");
  const hay = raw.toLowerCase();
  const words = raw.split(/\s+/).filter(Boolean).length;

  const disqualified = c.disqualifyAny.filter((t) => assertsCause(raw, t));
  if (disqualified.length > 0) {
    return ok(c, 0, `names a wrong root cause: ${disqualified.join(", ")}`, [
      `${c.path} contains "${disqualified[0]}"`,
    ]);
  }
  if (words < c.minWords) {
    return ok(c, 0, `${c.path} is ${words} words, below the ${c.minWords}-word minimum`);
  }
  if (c.requireAll.length === 0) return ok(c, 1, `${c.path} present, ${words} words`);

  const hitGroups = c.requireAll.filter((group) =>
    group.some((t) => hay.includes(t.toLowerCase())),
  );
  const missed = c.requireAll.filter((g) => !hitGroups.includes(g)).map((g) => g.join("|"));
  return ok(
    c,
    hitGroups.length / c.requireAll.length,
    `${hitGroups.length}/${c.requireAll.length} root-cause concepts named` +
      (missed.length > 0 ? `; missing: ${missed.join(", ")}` : ""),
  );
}

interface Finding {
  file?: unknown;
  line?: unknown;
  severity?: unknown;
  description?: unknown;
  title?: unknown;
}

/**
 * Grade a code review against the planted defect list.
 *
 * Scored as F1 rather than recall alone: an agent that reports every line as
 * defective would otherwise score 100% recall and look excellent.
 */
export function gradeFindings(
  findings: Finding[],
  defects: PlantedDefect[],
): { score: number; recall: number; precision: number; matched: string[]; detail: string } {
  const matchedDefects = new Set<string>();
  const usedFindings = new Set<number>();

  for (const d of defects) {
    for (let i = 0; i < findings.length; i++) {
      if (usedFindings.has(i)) continue;
      const f = findings[i] as Finding;
      const file = typeof f.file === "string" ? f.file : "";
      if (!file.endsWith(d.file) && !d.file.endsWith(file)) continue;
      const text = `${String(f.title ?? "")} ${String(f.description ?? "")}`.toLowerCase();
      if (!d.tokens.some((t) => text.includes(t.toLowerCase()))) continue;
      matchedDefects.add(d.id);
      usedFindings.add(i);
      break;
    }
  }

  const tp = matchedDefects.size;
  const recall = defects.length === 0 ? 0 : tp / defects.length;
  const precision = findings.length === 0 ? 0 : tp / findings.length;
  const score = tp === 0 ? 0 : (2 * recall * precision) / (recall + precision);
  return {
    score,
    recall,
    precision,
    matched: [...matchedDefects].sort(),
    detail: `${tp}/${defects.length} planted defects found in ${findings.length} report(s) — recall ${(recall * 100).toFixed(0)}%, precision ${(precision * 100).toFixed(0)}%`,
  };
}

async function runFindings(
  c: Extract<Check, { kind: "findings" }>,
  dir: string,
  defects: PlantedDefect[],
): Promise<CheckResult> {
  const p = join(dir, c.path);
  if (!existsSync(p)) return ok(c, 0, `${c.path} was never written`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    return ok(c, 0, `${c.path} is not valid JSON: ${(err as Error).message}`);
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { findings?: unknown }).findings)
      ? ((parsed as { findings: unknown[] }).findings as Finding[])
      : null;
  if (!list) return ok(c, 0, `${c.path} is not an array and has no "findings" array`);

  const g = gradeFindings(list as Finding[], defects);
  return ok(c, g.score, g.detail, [`matched: ${g.matched.join(", ") || "none"}`]);
}

async function runIdempotency(
  c: Extract<Check, { kind: "idempotency" }>,
  dir: string,
): Promise<CheckResult> {
  const first = await runCommand(c.command, { cwd: dir, timeoutMs: c.timeoutMs });
  if (first.exitCode !== 0) {
    return ok(
      c,
      0,
      `first run failed (exit ${first.exitCode}): ${first.stderr.slice(0, 200).trim()}`,
    );
  }
  const stateA = await runCommand(c.stateCommand, { cwd: dir, timeoutMs: c.timeoutMs });
  const second = await runCommand(c.command, { cwd: dir, timeoutMs: c.timeoutMs });
  if (second.exitCode !== 0) {
    return ok(
      c,
      0,
      `re-run failed (exit ${second.exitCode}): ${second.stderr.slice(0, 200).trim()}`,
    );
  }
  const stateB = await runCommand(c.stateCommand, { cwd: dir, timeoutMs: c.timeoutMs });

  const a = stateA.stdout.trim();
  const b = stateB.stdout.trim();
  if (a === "" && b === "") return cannotGrade(c, "state command produced no output either time");
  if (a === b) return ok(c, 1, `state stable across two runs (${a})`);
  return ok(c, 0, `re-running changed state: ${a} -> ${b}`, [`first: ${a}`, `second: ${b}`]);
}

async function runBehaviourUnchanged(
  c: Extract<Check, { kind: "behaviour-unchanged" }>,
  dir: string,
): Promise<CheckResult> {
  const r = await runCommand(c.command, { cwd: dir, timeoutMs: c.timeoutMs });
  if (r.timedOut) return cannotGrade(c, "characterization command timed out");
  if (r.exitCode !== 0) {
    return ok(c, 0, `characterization command failed (exit ${r.exitCode})`);
  }
  const got = createHash("sha256").update(r.stdout.trim()).digest("hex");
  if (got === c.expectedStdoutSha256) return ok(c, 1, "observable behaviour unchanged");
  return ok(c, 0, "observable behaviour CHANGED — the refactor was not behaviour-preserving", [
    `expected sha256 ${c.expectedStdoutSha256.slice(0, 12)}, got ${got.slice(0, 12)}`,
  ]);
}

async function runCommandCheck(
  c: Extract<Check, { kind: "command" }>,
  dir: string,
): Promise<CheckResult> {
  const r = await runCommand(c.command, { cwd: dir, timeoutMs: c.timeoutMs });
  if (r.timedOut) return cannotGrade(c, `command timed out after ${c.timeoutMs}ms`);
  return r.exitCode === 0
    ? ok(c, 1, "command exited 0")
    : ok(c, 0, `command exited ${r.exitCode}: ${(r.stderr || r.stdout).slice(0, 200).trim()}`);
}

/** Judge checks are dispatched by the runner, which owns the judge panel. */
export async function runCheck(
  c: Check,
  dir: string,
  defects: PlantedDefect[],
): Promise<CheckResult> {
  switch (c.kind) {
    case "command":
      return runCommandCheck(c, dir);
    case "vitest":
      return runVitest(c, dir);
    case "file-keywords":
      return runFileKeywords(c, dir);
    case "findings":
      return runFindings(c, dir, defects);
    case "idempotency":
      return runIdempotency(c, dir);
    case "behaviour-unchanged":
      return runBehaviourUnchanged(c, dir);
    case "judge":
      return cannotGrade(c, "judge checks are dispatched by the runner");
  }
}
