import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runCheck } from "./checks.js";
import { type LoadedTask, loadTasks } from "./config.js";
import { combineChecks } from "./runner.js";
import { createSandbox, destroySandbox, installHiddenAssets } from "./sandbox.js";

/**
 * Fixture invariant for A1, run at generation time.
 *
 * Two ways an agentic task is silently worthless:
 *
 *   - it already passes. Every model scores 100 and the task measures nothing.
 *   - it cannot pass. Every model scores 0 and the task measures nothing.
 *
 * Neither is visible from the scores alone — a suite of unsolvable tasks looks
 * exactly like a suite of models that are bad at coding. So every task ships
 * with a reference solution, and validation asserts the task FAILS as shipped
 * and PASSES with the solution overlaid. A task that cannot demonstrate both is
 * a broken fixture, not a hard problem.
 */
export interface TaskValidation {
  slug: string;
  shippedScore: number | null;
  solvedScore: number | null;
  ok: boolean;
  problems: string[];
  detail: string[];
}

async function scoreWith(lt: LoadedTask, overlay: string | null) {
  const sb = createSandbox(lt.taskDir, lt.task.slug);
  try {
    if (overlay) cpSync(overlay, sb.dir, { recursive: true });
    if (lt.hiddenDir) installHiddenAssets(sb, lt.hiddenDir);
    const results = [];
    for (const c of lt.task.checks) {
      // A judge check needs a live judge panel; validation runs offline.
      if (c.kind === "judge") continue;
      results.push(await runCheck(c, sb.dir, lt.task.defects));
    }
    const combined = combineChecks(results);
    return { score: combined.score, detail: results.map((r) => `${r.label}: ${r.detail}`) };
  } finally {
    destroySandbox(sb);
  }
}

export async function validateTask(lt: LoadedTask, gradingRoot: string): Promise<TaskValidation> {
  const problems: string[] = [];
  const detail: string[] = [];

  const gradeable = lt.task.checks.filter((c) => c.kind !== "judge");
  if (gradeable.length === 0) {
    return {
      slug: lt.task.slug,
      shippedScore: null,
      solvedScore: null,
      ok: true,
      problems: [],
      detail: ["only judge checks: validated at run time, not here"],
    };
  }

  const shipped = await scoreWith(lt, null);
  detail.push(...shipped.detail.map((d) => `shipped   ${d}`));

  const solutionDir = join(gradingRoot, lt.task.slug, "solution");
  if (!existsSync(solutionDir)) {
    problems.push(
      `no reference solution at grading/${lt.task.slug}/solution — the task cannot be shown solvable`,
    );
    return {
      slug: lt.task.slug,
      shippedScore: shipped.score,
      solvedScore: null,
      ok: false,
      problems,
      detail,
    };
  }

  const solved = await scoreWith(lt, solutionDir);
  detail.push(...solved.detail.map((d) => `solution  ${d}`));

  if (shipped.score === null) {
    problems.push("as-shipped run produced no score at all — checks are misconfigured");
  } else if (shipped.score >= 0.999) {
    problems.push(
      `passes as shipped (${(shipped.score * 100).toFixed(0)}/100) — there is nothing to solve`,
    );
  }
  if (solved.score === null) {
    problems.push("reference solution produced no score — checks are misconfigured");
  } else if (solved.score < 0.999) {
    problems.push(
      `reference solution only reaches ${(solved.score * 100).toFixed(0)}/100 — the task is not fully solvable as graded`,
    );
  }

  return {
    slug: lt.task.slug,
    shippedScore: shipped.score,
    solvedScore: solved.score,
    ok: problems.length === 0,
    problems,
    detail,
  };
}

export async function validateAll(root: string, only?: string[]): Promise<TaskValidation[]> {
  const tasks = loadTasks(root, only);
  const gradingRoot = join(root, "suites", "a1-agentic", "grading");
  const out: TaskValidation[] = [];
  for (const lt of tasks) out.push(await validateTask(lt, gradingRoot));
  return out;
}
