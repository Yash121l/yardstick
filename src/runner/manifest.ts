import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Attempt, GradeResult, RunManifest } from "../types.js";

export function gitSha(root: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function newRunId(now: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

/** Runs are append-only. Nothing here ever rewrites a previous run's files. */
export class RunWriter {
  readonly dir: string;

  constructor(
    runsRoot: string,
    readonly runId: string,
  ) {
    this.dir = join(runsRoot, runId);
    mkdirSync(this.dir, { recursive: true });
  }

  appendAttempt(a: Attempt): void {
    appendFileSync(join(this.dir, "attempts.jsonl"), `${JSON.stringify(a)}\n`);
  }

  writeManifest(m: RunManifest): void {
    writeFileSync(join(this.dir, "manifest.json"), `${JSON.stringify(m, null, 2)}\n`);
  }

  writeResults(payload: {
    manifest: RunManifest;
    grades: GradeResult[];
    attempts: Attempt[];
    aggregates?: unknown[];
    verdicts?: unknown[];
  }): void {
    writeFileSync(join(this.dir, "results.json"), `${JSON.stringify(payload, null, 2)}\n`);
  }

  writeHtml(html: string): void {
    writeFileSync(join(this.dir, "report.html"), html);
  }
}
