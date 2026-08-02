import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { Warehouse, demandsOrder } from "../graders/sql-exec.js";
import { generateP1, transcriptProblems } from "./p1.js";
import { assertP2Invariants, generateP2 } from "./p2.js";
import { QUESTIONS, SCHEMA_CARD, SCHEMA_SQL, generateData } from "./p3.js";
import { assertP4Invariants, generateP4 } from "./p4.js";
import { assertP5Invariants, generateP5 } from "./p5.js";
import { countWords, generateCorpus } from "./p6.js";
import { generateP7 } from "./p7.js";

/**
 * Fixture generation. Seeded and deterministic: same seed => byte-identical
 * output. Committed fixtures are frozen; regenerating with a different seed or
 * a changed generator MUST be accompanied by a fixtures.VERSION bump, because
 * scores are only comparable within a version.
 */

export const SEEDS = {
  p1: 20260801,
  p2: 20260802,
  p3: 20260804,
  p4: 20260805,
  p5: 20260806,
  p6: 20260803,
  p7: 20260807,
} as const;

const ROOT = process.cwd();

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function genP7(): void {
  // generateP7 asserts internally: every glyph drawable, no text overlapping
  // any other text, and every total equal to the sum of its parts. A fixture
  // that fails any of those measures the renderer, not the model.
  const r = generateP7(ROOT, SEEDS.p7);
  process.stdout.write(`p7: ${r.count} invoices rendered to ${r.dir}\n`);
}

function genP1(): void {
  const f = generateP1(SEEDS.p1, 25);
  const problems = f.transcripts.flatMap((t) => transcriptProblems(t).map((p) => `${t.id}: ${p}`));
  if (problems.length > 0) {
    throw new Error(`P1 fixtures are unsound:\n  ${problems.join("\n  ")}`);
  }

  const dir = join(ROOT, "suites", "p1-extraction");
  writeJson(join(dir, "fixtures", "transcripts.json"), {
    seed: SEEDS.p1,
    transcripts: f.transcripts.map((t) => ({
      id: t.id,
      title: t.title,
      company: t.company,
      text: t.text,
      requestedFields: t.requestedFields,
    })),
  });
  writeJson(join(dir, "gold", "facts.json"), {
    seed: SEEDS.p1,
    gold: f.transcripts.map((t) => ({ id: t.id, facts: t.facts })),
  });

  const words = f.transcripts.map((t) => t.text.split(/\s+/).length);
  const traps: Record<string, number> = {};
  for (const t of f.transcripts)
    for (const fa of t.facts) traps[fa.trapType] = (traps[fa.trapType] ?? 0) + 1;
  process.stdout.write(
    `p1: ${f.transcripts.length} transcripts, ` +
      `${Math.min(...words)}-${Math.max(...words)} words (~${Math.round(Math.min(...words) * 1.4)}-${Math.round(Math.max(...words) * 1.4)} tokens)\n`,
  );
  process.stdout.write(`  facts by trap: ${JSON.stringify(traps)}\n`);
}

function genP2(): void {
  const f = generateP2(SEEDS.p2);
  assertP2Invariants(f);

  const dir = join(ROOT, "suites", "p2-classification");
  writeJson(join(dir, "fixtures", "items.json"), {
    seed: SEEDS.p2,
    watchlist: f.watchlist,
    thesis: f.thesis,
    items: f.items,
  });
  writeJson(join(dir, "gold", "gold.json"), { seed: SEEDS.p2, gold: f.gold });

  const byLabelSet: Record<string, number> = {};
  const byTrap: Record<string, number> = {};
  for (const i of f.items) {
    byLabelSet[i.labelSet] = (byLabelSet[i.labelSet] ?? 0) + 1;
    byTrap[i.trapType] = (byTrap[i.trapType] ?? 0) + 1;
  }
  process.stdout.write(`p2: ${f.items.length} items\n`);
  process.stdout.write(`  by label set: ${JSON.stringify(byLabelSet)}\n`);
  process.stdout.write(`  by trap:      ${JSON.stringify(byTrap)}\n`);
}

async function genP3(): Promise<void> {
  const dir = join(ROOT, "suites", "p3-sql");
  mkdirSync(join(dir, "fixtures"), { recursive: true });
  const dbPath = join(dir, "fixtures", "warehouse.duckdb");
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}.wal`, { force: true });

  const data = generateData(SEEDS.p3);
  {
    const instance = await DuckDBInstance.create(dbPath);
    const conn = await instance.connect();
    for (const stmt of SCHEMA_SQL.split(";")
      .map((x) => x.trim())
      .filter(Boolean)) {
      await conn.run(stmt);
    }
    for (const stmt of data.inserts) await conn.run(stmt);
    conn.closeSync();
    instance.closeSync();
  }

  // Every gold query is EXECUTED here. A query that errors, or whose
  // empty/non-empty shape contradicts its declaration, fails generation rather
  // than shipping a question that can never be answered correctly.
  const wh = await Warehouse.openReadOnly(dbPath);
  const problems: string[] = [];
  const shapes: { id: string; rows: number; cols: number; ordered: boolean }[] = [];
  try {
    for (const q of QUESTIONS) {
      const out = await wh.runChecked(q.goldSql);
      if (!out.ok) {
        problems.push(`${q.id}: gold SQL failed (${out.kind}): ${out.detail}`);
        continue;
      }
      if (q.expectEmpty && out.rows.length !== 0) {
        problems.push(`${q.id}: declared empty but returned ${out.rows.length} rows`);
      }
      if (!q.expectEmpty && out.rows.length === 0) {
        problems.push(`${q.id}: declared non-empty but returned 0 rows`);
      }
      shapes.push({
        id: q.id,
        rows: out.rows.length,
        cols: out.columns.length,
        ordered: demandsOrder(q.goldSql),
      });
    }
  } finally {
    await wh.close();
  }
  if (problems.length > 0) {
    throw new Error(`P3 gold queries are unsound:\n  ${problems.join("\n  ")}`);
  }

  writeJson(join(dir, "fixtures", "questions.json"), {
    seed: SEEDS.p3,
    schemaCard: SCHEMA_CARD,
    questions: QUESTIONS.map((q) => ({
      id: q.id,
      question: q.question,
      expectEmpty: q.expectEmpty,
      trap: q.trap,
      note: q.note,
    })),
  });
  writeJson(join(dir, "gold", "queries.json"), {
    seed: SEEDS.p3,
    gold: QUESTIONS.map((q) => ({ id: q.id, goldSql: q.goldSql, expectEmpty: q.expectEmpty })),
  });

  const empties = shapes.filter((s) => s.rows === 0).length;
  process.stdout.write(
    `p3: ${data.companyCount} companies, ${data.rowCount} rows, ${QUESTIONS.length} questions\n`,
  );
  process.stdout.write(
    `  all ${QUESTIONS.length} gold queries executed; ${empties} return zero rows; ` +
      `${shapes.filter((s) => s.ordered).length} demand an ordering\n`,
  );
}

function genP4(): void {
  const packs = generateP4(SEEDS.p4, 12);
  assertP4Invariants(packs);
  writeJson(join(ROOT, "suites", "p4-writing", "fixtures", "packs.json"), {
    seed: SEEDS.p4,
    packs,
  });
  const words = packs.map((p) => p.text.split(/\s+/).length);
  process.stdout.write(
    `p4: ${packs.length} packs x 3 doc types = ${packs.length * 3} items, ` +
      `${Math.min(...words)}-${Math.max(...words)} words per pack\n`,
  );
}

function genP5(): void {
  const f = generateP5(SEEDS.p5);
  assertP5Invariants(f);
  const dir = join(ROOT, "suites", "p5-longcontext");
  for (const v of f.vaults) {
    mkdirSync(join(dir, "fixtures"), { recursive: true });
    writeFileSync(join(dir, "fixtures", `vault-${v.size}.md`), v.text);
  }
  writeJson(join(dir, "gold", "questions.json"), {
    seed: SEEDS.p5,
    sizes: f.vaults.map((v) => ({ size: v.size, approxTokens: v.approxTokens })),
    questions: f.questions,
    traps: f.traps,
  });
  process.stdout.write(
    `p5: vaults ${f.vaults.map((v) => `${v.size}=~${v.approxTokens} tok`).join(", ")}; ` +
      `${f.questions.length} retrieval questions, ${f.traps.length} rule traps, ${f.rules.length} binding rules\n`,
  );
}

function genP6(): void {
  const text = generateCorpus(SEEDS.p6, 10_000);
  const words = countWords(text);
  if (words < 9800 || words > 10400) {
    throw new Error(`p6 corpus is ${words} words, expected ~10,000`);
  }
  const dir = join(ROOT, "suites", "p6-contracts", "fixtures");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "corpus.txt"), text);
  process.stdout.write(`p6: tokenizer corpus ${words} words, ${text.length} chars\n`);
}

async function main(): Promise<void> {
  const which = process.argv[2] ?? "all";
  if (which === "all" || which === "p1") genP1();
  if (which === "all" || which === "p2") genP2();
  if (which === "all" || which === "p3") await genP3();
  if (which === "all" || which === "p4") genP4();
  if (which === "all" || which === "p5") genP5();
  if (which === "all" || which === "p6") genP6();
  if (which === "all" || which === "p7") genP7();

  const version = readFileSync(join(ROOT, "fixtures.VERSION"), "utf8").trim();
  process.stdout.write(
    `\nfixtures.VERSION = ${version}\n` +
      `If the generator or a seed changed, bump it — scores only compare within a version.\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
