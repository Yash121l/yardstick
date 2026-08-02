import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type JudgeEntry,
  JudgesFile,
  type ModelEntry,
  ModelsFile,
  type ProviderName,
} from "./types.js";

export const JUDGE_SENTINEL = "TODO-PIN-JUDGE-MODEL-ID";

export interface Config {
  root: string;
  models: ModelEntry[];
  judges: { primary: JudgeEntry; secondary: JudgeEntry | null; rubricVersion: string };
  fixturesVersion: string;
}

export class ConfigError extends Error {}

function read(root: string, name: string): string {
  try {
    return readFileSync(join(root, name), "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read ${name}: ${(err as Error).message}`);
  }
}

/**
 * Reject request profiles the API is known to reject, before any spend.
 * These are hard 400s, not preferences.
 */
export function validateProfile(entry: ModelEntry): string[] {
  const errors: string[] = [];
  const { thinking, effort } = entry.profile;
  const caps = entry.capabilities;

  if (thinking === "disabled" && caps?.thinkingModes && !caps.thinkingModes.includes("off")) {
    errors.push(
      `${entry.id}: profile sets thinking=disabled but capabilities.thinkingModes ` +
        `(${caps.thinkingModes.join(", ")}) does not include "off" — this returns 400.`,
    );
  }

  // Opus 5: `thinking: disabled` is accepted only at effort <= high.
  if (thinking === "disabled" && effort && ["xhigh", "max"].includes(effort)) {
    errors.push(
      `${entry.id}: profile pairs thinking=disabled with effort=${effort}. ` +
        `Disabling thinking above effort "high" is a 400 on current Anthropic models. ` +
        `Use effort <= high, or thinking=default.`,
    );
  }

  if (effort && caps?.effortLevels && caps.effortLevels.length === 0) {
    errors.push(
      `${entry.id}: profile sets effort=${effort} but this model has no effort parameter.`,
    );
  }

  if (
    effort &&
    caps?.effortLevels &&
    caps.effortLevels.length > 0 &&
    !caps.effortLevels.includes(effort)
  ) {
    errors.push(`${entry.id}: effort=${effort} is not one of ${caps.effortLevels.join(", ")}.`);
  }

  return errors;
}

export function loadConfig(root: string): Config {
  const rawModels: unknown = parseYaml(read(root, "models.yaml"));
  const modelsParsed = ModelsFile.safeParse(rawModels);
  if (!modelsParsed.success) {
    throw new ConfigError(`models.yaml is invalid:\n${formatZod(modelsParsed.error.issues)}`);
  }
  const models = modelsParsed.data;

  const ids = new Set<string>();
  for (const m of models) {
    if (ids.has(m.id)) throw new ConfigError(`models.yaml: duplicate model id "${m.id}"`);
    ids.add(m.id);
  }

  // Exactly one baseline per role. Two is not a preference the runner can
  // resolve — it would pick whichever appears first in the file, and the
  // verdict lines would compare against an incumbent nobody chose.
  const baselineByRole = new Map<string, string[]>();
  for (const m of models) {
    if (!m.baseline) continue;
    for (const r of m.baselineRoles ?? m.roles) {
      baselineByRole.set(r, [...(baselineByRole.get(r) ?? []), m.id]);
    }
  }
  const ambiguous = [...baselineByRole.entries()].filter(([, ids]) => ids.length > 1);
  if (ambiguous.length > 0) {
    throw new ConfigError(
      `models.yaml has more than one baseline for a role:\n  ${ambiguous
        .map(([role, ids]) => `${role}: ${ids.join(", ")}`)
        .join("\n  ")}\n` +
        `Add \`baselineRoles:\` to each so exactly one model is the baseline for each role.`,
    );
  }

  const profileErrors = models.flatMap(validateProfile);
  if (profileErrors.length > 0) {
    throw new ConfigError(
      `models.yaml request profiles are unusable:\n  ${profileErrors.join("\n  ")}`,
    );
  }

  const rawJudges: unknown = parseYaml(read(root, "judges.yaml"));
  const judgesParsed = JudgesFile.safeParse(rawJudges);
  if (!judgesParsed.success) {
    throw new ConfigError(`judges.yaml is invalid:\n${formatZod(judgesParsed.error.issues)}`);
  }

  const fixturesVersion = read(root, "fixtures.VERSION").trim();
  if (!fixturesVersion) throw new ConfigError("fixtures.VERSION is empty");

  return {
    root,
    models,
    judges: judgesParsed.data,
    fixturesVersion,
  };
}

function formatZod(issues: { path: (string | number)[]; message: string }[]): string {
  return issues.map((i) => `  at ${i.path.join(".") || "<root>"}: ${i.message}`).join("\n");
}

/** Baseline lookup per pipeline role. */
export function baselineFor(models: ModelEntry[], role: string): ModelEntry | null {
  return models.find((m) => m.baseline && m.roles.includes(role as never)) ?? null;
}

export function judgeIsPinned(judge: JudgeEntry): boolean {
  return judge.id !== JUDGE_SENTINEL;
}

/** Providers referenced by the given models. */
export function providersUsed(models: ModelEntry[]): ProviderName[] {
  return [...new Set(models.map((m) => m.provider))];
}
