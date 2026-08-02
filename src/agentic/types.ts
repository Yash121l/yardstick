import { z } from "zod";

/**
 * A1 — agentic coding.
 *
 * A1 does not go through the provider adapters. Every other suite is one HTTP
 * request whose response is the answer; an A1 item is an *agent CLI* invoked
 * against a scratch copy of a small repo, and the answer is what the repo looks
 * like afterwards. That makes it a separate execution path (`src/agentic/`)
 * rather than a `Suite`, but it emits the same Attempt/GradeResult shapes so the
 * report, the scoreboard and the verdict engine treat it like anything else.
 *
 * The invocation is a template string so any agent CLI can be swapped in, not
 * just Claude Code.
 */

/** One graded assertion about the sandbox after the agent has finished. */
export const Check = z.discriminatedUnion("kind", [
  /** Run a command; scores 1 on exit 0, 0 otherwise. */
  z.object({
    kind: z.literal("command"),
    label: z.string(),
    command: z.array(z.string()).min(1),
    timeoutMs: z.number().int().positive().default(120_000),
    weight: z.number().positive().default(1),
  }),
  /** Run vitest and score the pass rate over the hidden tests. */
  z.object({
    kind: z.literal("vitest"),
    label: z.string(),
    /** Relative to the sandbox root. */
    testDir: z.string().default("hidden-tests"),
    timeoutMs: z.number().int().positive().default(300_000),
    weight: z.number().positive().default(1),
  }),
  /**
   * A file the agent had to write must name the actual root cause.
   *
   * Deliberately keyword-based with a judge fallback: the point of the
   * debug-from-symptoms task is that the agent *diagnosed* the fault, and a
   * fix that happens to work while the write-up names the wrong cause should
   * not score full marks.
   */
  z.object({
    kind: z.literal("file-keywords"),
    label: z.string(),
    path: z.string(),
    /** Every group must match at least one of its alternatives. */
    requireAll: z.array(z.array(z.string())).default([]),
    /** Any hit here is a wrong diagnosis and zeroes the check. */
    disqualifyAny: z.array(z.string()).default([]),
    minWords: z.number().int().nonnegative().default(0),
    weight: z.number().positive().default(1),
  }),
  /** Compare a findings.json against the planted defect list. */
  z.object({
    kind: z.literal("findings"),
    label: z.string(),
    path: z.string().default("findings.json"),
    weight: z.number().positive().default(1),
  }),
  /** Run a command twice; the second run must not change the recorded state. */
  z.object({
    kind: z.literal("idempotency"),
    label: z.string(),
    command: z.array(z.string()).min(1),
    /** Command whose stdout is the state fingerprint (row count, checksum). */
    stateCommand: z.array(z.string()).min(1),
    timeoutMs: z.number().int().positive().default(120_000),
    weight: z.number().positive().default(1),
  }),
  /** Anchored-rubric judge over a produced artifact. */
  z.object({
    kind: z.literal("judge"),
    label: z.string(),
    path: z.string(),
    rubricId: z.string(),
    weight: z.number().positive().default(1),
  }),
  /**
   * Characterization: a baseline command's stdout must be byte-identical
   * before and after the agent's refactor.
   */
  z.object({
    kind: z.literal("behaviour-unchanged"),
    label: z.string(),
    command: z.array(z.string()).min(1),
    /** Captured at generation time, before the agent ever runs. */
    expectedStdoutSha256: z.string(),
    timeoutMs: z.number().int().positive().default(120_000),
    weight: z.number().positive().default(1),
  }),
]);
export type Check = z.infer<typeof Check>;

/** One planted defect in the code-review task. */
export const PlantedDefect = z.object({
  id: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  category: z.enum(["security", "logic", "concurrency", "perf"]),
  /** A finding counts as a hit if it names the file and any of these. */
  tokens: z.array(z.string()).min(1),
});
export type PlantedDefect = z.infer<typeof PlantedDefect>;

export const AgenticTask = z.object({
  slug: z.string(),
  title: z.string(),
  /** Wall-clock budget for the agent. Exceeding it is a recorded failure. */
  timeoutMs: z.number().int().positive().default(900_000),
  /** Creating a git commit is a compliance violation unless this is true. */
  allowGitCommit: z.boolean().default(false),
  /** Binaries the checks need. Missing => the item is ungraded, never scored 0. */
  requires: z.array(z.enum(["node", "python3"])).default(["node"]),
  /** Files the agent is expected to produce; absence is reported per file. */
  expectArtifacts: z.array(z.string()).default([]),
  checks: z.array(Check).min(1),
  defects: z.array(PlantedDefect).default([]),
  weight: z.number().positive().default(1),
});
export type AgenticTask = z.infer<typeof AgenticTask>;

/** What the harness observed about one agent run, before grading. */
export interface AgentRun {
  slug: string;
  modelId: string;
  sandboxDir: string;
  exitCode: number | null;
  timedOut: boolean;
  wallMs: number;
  stdout: string;
  stderr: string;
  /**
   * Reported by the agent CLI, not inferred.
   *
   * Null means the CLI told us nothing. Null is NOT zero: a zero here would
   * make the verdict engine's cost gate believe an agent run was free.
   */
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

/** Compliance is graded separately from capability and never averaged in. */
export interface Compliance {
  /** A commit exists that the task did not authorise. */
  unauthorisedGitCommit: boolean;
  /** A live secret value from the environment appeared in the transcript. */
  secretEchoed: boolean;
  /** Evidence the agent touched something outside its sandbox. */
  escapedSandbox: boolean;
  /** Detail lines, safe to print — never containing key material. */
  detail: string[];
}
