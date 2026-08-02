import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { AgenticTask } from "./types.js";

export const AgentConfig = z.object({
  invocation: z.string().min(1),
  timeoutMs: z.number().int().positive().default(900_000),
  usage: z.enum(["claude-json", "none"]).default("none"),
  env: z.record(z.string()).default({}),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

export class AgenticConfigError extends Error {}

export const TASKS_DIR = join("suites", "a1-agentic", "tasks");
export const GRADING_DIR = join("suites", "a1-agentic", "grading");

export function loadAgentConfig(root: string): AgentConfig {
  const p = join(root, "agents.yaml");
  if (!existsSync(p)) {
    throw new AgenticConfigError(
      "A1 needs agents.yaml, which defines the agent CLI invocation. See the template in the repo root.",
    );
  }
  const parsed = AgentConfig.safeParse(parseYaml(readFileSync(p, "utf8")));
  if (!parsed.success) {
    throw new AgenticConfigError(
      `agents.yaml is invalid:\n  ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ")}`,
    );
  }
  return parsed.data;
}

export interface LoadedTask {
  task: AgenticTask;
  /** Copied into the sandbox. */
  taskDir: string;
  /** Never copied until after the agent has finished. */
  hiddenDir: string | null;
}

/**
 * Load every task under suites/a1-agentic/.
 *
 * The grading assets live OUTSIDE the task directory on purpose: an agent that
 * can read the hidden tests can satisfy them without solving the task, and it
 * would be graded as a success.
 */
export function loadTasks(root: string, only?: string[]): LoadedTask[] {
  const tasksRoot = join(root, TASKS_DIR);
  const gradingRoot = join(root, GRADING_DIR);
  if (!existsSync(tasksRoot)) {
    throw new AgenticConfigError(`no A1 tasks found at ${TASKS_DIR}. Run \`npm run gen -- a1\`.`);
  }

  const out: LoadedTask[] = [];
  for (const slug of readdirSync(tasksRoot).sort()) {
    if (only && only.length > 0 && !only.includes(slug)) continue;
    const taskDir = join(tasksRoot, slug);
    const cfgPath = join(gradingRoot, slug, "task.yaml");
    if (!existsSync(cfgPath)) {
      throw new AgenticConfigError(
        `task "${slug}" has no grading config at ${GRADING_DIR}/${slug}/task.yaml`,
      );
    }
    const parsed = AgenticTask.safeParse(parseYaml(readFileSync(cfgPath, "utf8")));
    if (!parsed.success) {
      throw new AgenticConfigError(
        `${GRADING_DIR}/${slug}/task.yaml is invalid:\n  ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("\n  ")}`,
      );
    }
    if (parsed.data.slug !== slug) {
      throw new AgenticConfigError(
        `${GRADING_DIR}/${slug}/task.yaml declares slug "${parsed.data.slug}" but lives in "${slug}"`,
      );
    }
    if (!existsSync(join(taskDir, "PROMPT.md"))) {
      throw new AgenticConfigError(`task "${slug}" has no PROMPT.md`);
    }
    const hidden = join(gradingRoot, slug, "tests");
    out.push({
      task: parsed.data,
      taskDir,
      hiddenDir: existsSync(hidden) ? hidden : null,
    });
  }
  if (out.length === 0) throw new AgenticConfigError("no A1 tasks matched");
  return out;
}
