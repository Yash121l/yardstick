import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RoleVerdict } from "../graders/verdict.js";
import { renderHtmlReport } from "../report/html-report.js";
import { SUITES } from "../suites/index.js";
import type { SuiteAggregate } from "../suites/types.js";
import type { Attempt, GradeResult, RunManifest } from "../types.js";

/**
 * Re-render a report from a completed run's results.json.
 *
 * Zero API calls: everything the report needs is already on disk. Exists so a
 * slim variant can be produced for a 512 KB static host without re-running the
 * matrix or hand-editing generated HTML.
 */
const args = process.argv.slice(2);
const runId = args.find((a) => !a.startsWith("-"));
const slim = args.includes("--slim");
if (!runId) {
  process.stderr.write("usage: npm run report -- <runId> [--slim]\n");
  process.exit(1);
}

const dir = join(process.cwd(), "runs", runId);
const resultsPath = join(dir, "results.json");
if (!existsSync(resultsPath)) {
  process.stderr.write(`no results.json in runs/${runId}\n`);
  process.exit(1);
}

const payload = JSON.parse(readFileSync(resultsPath, "utf8")) as {
  manifest: RunManifest;
  attempts: Attempt[];
  grades: GradeResult[];
  aggregates?: SuiteAggregate[];
  verdicts?: RoleVerdict[];
};

// Roles come from the suite registry, matched to what the run actually covered.
const suiteRoles = Object.fromEntries(
  [...new Set(payload.grades.map((g) => g.suite))].map((id) => [
    id,
    (SUITES[id]?.roles as string[] | undefined) ?? [],
  ]),
);

const html = renderHtmlReport({
  manifest: payload.manifest,
  attempts: payload.attempts,
  grades: payload.grades,
  aggregates: payload.aggregates ?? [],
  verdicts: payload.verdicts ?? [],
  suiteRoles,
  slim,
});

const out = join(dir, slim ? "report.slim.html" : "report.html");
writeFileSync(out, html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
process.stdout.write(`wrote ${out} (${kb} KB${slim ? ", slim" : ""})\n`);
if (slim && Buffer.byteLength(html) > 524_288) {
  process.stdout.write(
    `WARNING: ${kb} KB still exceeds the 512 KB static-host limit; split it instead of compressing further.\n`,
  );
}
