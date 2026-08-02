import { validateAll } from "../agentic/validate.js";

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const verbose = process.argv.includes("--verbose");

const results = await validateAll(process.cwd(), only.length > 0 ? only : undefined);
let bad = 0;
for (const r of results) {
  const fmt = (n: number | null) => (n === null ? "  —" : `${(n * 100).toFixed(0).padStart(3)}`);
  process.stdout.write(
    `${r.ok ? "ok  " : "FAIL"}  ${r.slug.padEnd(20)} shipped ${fmt(r.shippedScore)}/100   solution ${fmt(r.solvedScore)}/100\n`,
  );
  for (const p of r.problems) process.stdout.write(`        ${p}\n`);
  if (verbose) for (const d of r.detail) process.stdout.write(`        ${d}\n`);
  if (!r.ok) bad++;
}
process.stdout.write(
  `\n${results.length - bad}/${results.length} task(s) well-formed ` +
    `(fails as shipped, passes with the reference solution)\n`,
);
process.exit(bad === 0 ? 0 : 1);
