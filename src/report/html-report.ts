import { type ConfidenceInterval, bootstrapCI, ciOverlap } from "../graders/stats.js";
import type { SuiteAggregate } from "../suites/types.js";
import type { Attempt, GradeResult, RunManifest } from "../types.js";
import type { RoleVerdict } from "./../graders/verdict.js";

/**
 * Single self-contained HTML report. Inline CSS and JS, no external requests
 * of any kind — it must open from disk on a plane.
 *
 * Full fixtures and raw responses are NOT embedded: 25 transcripts at 8k tokens
 * across three repeats and several models would produce a file too large to
 * open. Grader evidence is embedded in full (it is compact and is the thing you
 * actually click into), and model output is truncated with the length shown.
 */

const OUTPUT_PREVIEW_CHARS = 2000;
/** Slim mode: enough to see the shape of a response, not the whole of it. */
const SLIM_PREVIEW_CHARS = 220;

interface ItemRow {
  suite: string;
  itemId: string;
  modelId: string;
  repeat: number;
  status: string;
  score: number | null;
  violations: { kind: string; detail: string }[];
  evidence: string[];
  output: string;
  outputTruncated: boolean;
  costUsd: number;
  latencyMs: number;
  paramsDropped: string[];
  ungradedReason: string | null;
}

interface SuiteScore {
  suite: string;
  modelId: string;
  baseline: boolean;
  ci: ConfidenceInterval;
  costUsd: number;
  n: number;
  ungraded: number;
}

export interface ReportInput {
  manifest: RunManifest;
  attempts: Attempt[];
  grades: GradeResult[];
  aggregates: SuiteAggregate[];
  /** suite id -> pipeline roles it informs, so the right baseline is chosen. */
  suiteRoles: Record<string, string[]>;
  verdicts: RoleVerdict[];
  /**
   * Produce a variant small enough for a 512 KB static host.
   *
   * The drill-down is ~80% of a full report's bytes, and a three-model run is
   * 2.3 MB. Slim keeps every score, metric, verdict and aggregate untouched and
   * narrows only the drill-down: raw outputs are shortened, and rows that
   * scored a clean 1.0 with no violations are dropped. Those are the rows
   * nobody opens — the drill-down exists to inspect failures — and the page
   * states how many were omitted rather than implying the run was smaller.
   */
  slim?: boolean;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Safe to drop inside a <script> tag. */
function embed(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Rows a reader would actually open: anything that did not cleanly pass. */
function isInteresting(r: ItemRow): boolean {
  return r.status !== "graded" || r.score === null || r.score < 0.999 || r.violations.length > 0;
}

function buildRows(input: ReportInput): ItemRow[] {
  const previewChars = input.slim ? SLIM_PREVIEW_CHARS : OUTPUT_PREVIEW_CHARS;
  const byAttempt = new Map(input.attempts.map((a) => [a.attemptId, a]));
  return input.grades
    .map((g): ItemRow => {
      const a = byAttempt.get(g.attemptId);
      const raw =
        a?.response?.json !== undefined
          ? JSON.stringify(a.response.json, null, 1)
          : (a?.response?.text ?? (a?.error ? `ERROR: ${a.error.kind}: ${a.error.detail}` : ""));
      return {
        suite: g.suite,
        itemId: g.itemId,
        modelId: g.modelId,
        repeat: a?.repeatIndex ?? 0,
        status: g.status,
        score: g.score,
        violations: g.violations.map((v) => ({ kind: v.kind, detail: v.detail })),
        evidence: g.evidence,
        output: raw.slice(0, previewChars),
        outputTruncated: raw.length > previewChars,
        costUsd: a?.costUsd ?? 0,
        latencyMs: a?.response?.latencyMs ?? 0,
        paramsDropped: a?.response?.paramsDropped ?? [],
        ungradedReason: g.ungradedReason,
      };
    })
    .sort(
      (x, y) =>
        x.suite.localeCompare(y.suite) ||
        x.itemId.localeCompare(y.itemId) ||
        x.modelId.localeCompare(y.modelId) ||
        x.repeat - y.repeat,
    );
}

function buildScores(input: ReportInput): SuiteScore[] {
  const key = (s: string, m: string) => `${s} ${m}`;
  const perItem = new Map<string, Map<string, number[]>>();
  const costs = new Map<string, number>();
  const ungraded = new Map<string, number>();

  for (const g of input.grades) {
    const k = key(g.suite, g.modelId);
    if (!perItem.has(k)) perItem.set(k, new Map());
    if (g.status === "graded" && g.score !== null) {
      const items = perItem.get(k)!;
      const list = items.get(g.itemId) ?? [];
      list.push(g.score);
      items.set(g.itemId, list);
    } else {
      ungraded.set(k, (ungraded.get(k) ?? 0) + 1);
    }
  }
  for (const a of input.attempts) {
    const k = key(a.suite, a.modelId);
    costs.set(k, (costs.get(k) ?? 0) + a.costUsd);
  }

  const out: SuiteScore[] = [];
  for (const [k, items] of perItem) {
    const [suite, modelId] = k.split(" ") as [string, string];
    // Resample ITEMS, not attempts: repeats of one item are not independent
    // observations, and treating them as such would understate the interval.
    const itemMeans = [...items.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
    out.push({
      suite,
      modelId,
      baseline: isBaselineFor(input, suite, modelId),
      ci: bootstrapCI(itemMeans),
      costUsd: costs.get(k) ?? 0,
      n: itemMeans.length,
      ungraded: ungraded.get(k) ?? 0,
    });
  }
  return out.sort((a, b) => a.suite.localeCompare(b.suite) || a.modelId.localeCompare(b.modelId));
}

/**
 * A model is the baseline FOR A SUITE only if it is a declared baseline AND it
 * holds a role that suite informs. With two baselines in one run (a cheap-tier
 * classify pin and a mid-tier extract pin), picking whichever came first would
 * label the wrong model as the thing to beat.
 */
function isBaselineFor(input: ReportInput, suite: string, modelId: string): boolean {
  const m = input.manifest.models.find((x) => x.id === modelId);
  if (!m?.baseline) return false;
  const roles = input.suiteRoles[suite] ?? [];
  if (roles.length === 0) return false;
  return roles.some((r) => (m.roles as string[]).includes(r));
}

/** Items where a candidate and the baseline disagree, for the diff view. */
function buildDisagreements(scores: SuiteScore[], rows: ItemRow[]): string[] {
  const baselineBySuite = new Map<string, string>();
  for (const s of scores) if (s.baseline) baselineBySuite.set(s.suite, s.modelId);

  const meanByKey = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.score === null) continue;
    const k = `${r.suite}\u0000${r.itemId}\u0000${r.modelId}`;
    meanByKey.set(k, (meanByKey.get(k) ?? 0) + r.score);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const [k, v] of meanByKey) meanByKey.set(k, v / (counts.get(k) ?? 1));

  const out = new Set<string>();
  for (const r of rows) {
    const base = baselineBySuite.get(r.suite);
    if (!base || base === r.modelId) continue;
    const mine = meanByKey.get(`${r.suite}\u0000${r.itemId}\u0000${r.modelId}`);
    const theirs = meanByKey.get(`${r.suite}\u0000${r.itemId}\u0000${base}`);
    if (mine === undefined || theirs === undefined) continue;
    if (Math.abs(mine - theirs) > 1e-9) out.add(`${r.suite}\u0000${r.itemId}`);
  }
  return [...out];
}

function scoreboardHtml(scores: SuiteScore[]): string {
  const suites = [...new Set(scores.map((s) => s.suite))].sort();
  const models = [...new Set(scores.map((s) => s.modelId))].sort();
  const head = ["model", ...suites].map((h) => `<th>${esc(h)}</th>`).join("");
  const body = models
    .map((m) => {
      const isBase = scores.some((s) => s.modelId === m && s.baseline);
      const cells = suites
        .map((su) => {
          const s = scores.find((x) => x.suite === su && x.modelId === m);
          if (!s) return `<td class="muted">—</td>`;
          const pct = (s.ci.point * 100).toFixed(1);
          const lo = (s.ci.lo * 100).toFixed(1);
          const hi = (s.ci.hi * 100).toFixed(1);
          const width = Math.max(2, (s.ci.hi - s.ci.lo) * 100);
          const left = s.ci.lo * 100;
          return `<td>
            <div class="scoreline"><b>${pct}</b> <span class="muted">${lo}–${hi}</span></div>
            <div class="whisker" title="95% CI ${lo}–${hi} over ${s.n} items">
              <span style="left:${left}%;width:${width}%"></span>
              <i style="left:${s.ci.point * 100}%"></i>
            </div>
            ${s.ungraded > 0 ? `<div class="warn">${s.ungraded} ungraded</div>` : ""}
          </td>`;
        })
        .join("");
      return `<tr><th class="rowhead">${esc(m)}${isBase ? ' <span class="pill">baseline</span>' : ""}</th>${cells}</tr>`;
    })
    .join("");
  return `<table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function tieNotes(scores: SuiteScore[]): string {
  const suites = [...new Set(scores.map((s) => s.suite))].sort();
  const lines: string[] = [];
  for (const su of suites) {
    const rows = scores.filter((s) => s.suite === su);
    const base = rows.find((r) => r.baseline);
    if (!base) continue;
    for (const cand of rows.filter((r) => !r.baseline)) {
      const delta = (cand.ci.point - base.ci.point) * 100;
      const overlap = ciOverlap(cand.ci, base.ci);
      lines.push(
        `<li><code>${esc(su)}</code> ${esc(cand.modelId)} vs ${esc(base.modelId)}: ` +
          `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} points — ` +
          (overlap
            ? `<b class="tie">tie within noise</b> (confidence intervals overlap)`
            : `<b class="sep">separated</b> (intervals do not overlap)`) +
          `</li>`,
      );
    }
  }
  return lines.length === 0
    ? `<p class="muted">No baseline/candidate pair in this run.</p>`
    : `<ul class="ties">${lines.join("")}</ul>`;
}

function scatterHtml(scores: SuiteScore[]): string {
  const suites = [...new Set(scores.map((s) => s.suite))].sort();
  return suites
    .map((su) => {
      const rows = scores.filter((s) => s.suite === su && s.costUsd > 0);
      if (rows.length === 0) {
        return `<div class="chart"><h4>${esc(su)}</h4><p class="muted">no billed calls this run (cache hits)</p></div>`;
      }
      const maxCost = Math.max(...rows.map((r) => r.costUsd)) * 1.15;
      const W = 320;
      const H = 190;
      const pad = 34;
      const pts = rows
        .map((r) => {
          const x = pad + (r.costUsd / maxCost) * (W - pad - 12);
          const y = H - pad - r.ci.point * (H - pad - 12);
          return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" class="${r.baseline ? "base" : "cand"}"><title>${esc(r.modelId)}: ${(r.ci.point * 100).toFixed(1)} at $${r.costUsd.toFixed(4)}</title></circle>
            <text x="${(x + 8).toFixed(1)}" y="${(y + 4).toFixed(1)}" class="lbl">${esc(r.modelId.replace(/^claude-/, ""))}</text>`;
        })
        .join("");
      return `<div class="chart"><h4>${esc(su)} — cost vs score</h4>
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="cost versus score for ${esc(su)}">
          <line x1="${pad}" y1="${H - pad}" x2="${W - 6}" y2="${H - pad}" class="axis"/>
          <line x1="${pad}" y1="8" x2="${pad}" y2="${H - pad}" class="axis"/>
          <text x="${pad}" y="${H - 10}" class="tick">$0</text>
          <text x="${W - 40}" y="${H - 10}" class="tick">$${maxCost.toFixed(3)}</text>
          <text x="4" y="${H - pad}" class="tick">0</text>
          <text x="4" y="16" class="tick">100</text>
          ${pts}
        </svg></div>`;
    })
    .join("");
}

function quirksHtml(aggregates: SuiteAggregate[]): string {
  const rows = aggregates.filter((a) => Object.keys(a.cells).length > 0);
  if (rows.length === 0) return "";
  const probes = [...new Set(rows.flatMap((r) => Object.keys(r.cells)))].sort();
  const head = ["probe", ...rows.map((r) => r.modelId)].map((h) => `<th>${esc(h)}</th>`).join("");
  const body = probes
    .map((p) => {
      const cells = rows
        .map((r) => {
          const c = r.cells[p];
          if (!c) return `<td class="muted">—</td>`;
          return `<td class="cell ${c.status}" title="${esc(c.detail)}">${c.status === "pass" ? "ok" : c.status.toUpperCase()}</td>`;
        })
        .join("");
      return `<tr><th class="rowhead">${esc(p)}</th>${cells}</tr>`;
    })
    .join("");
  return `<section><h2>P6 quirks matrix</h2>
    <p class="muted">A red cell on a parameter a pipeline needs blocks that model for that role.
    <b>IGNORED</b> means the parameter was accepted but had no observable effect — worse than a
    rejection, because nothing tells you at call time. Hover any cell for the detail.</p>
    <table class="grid quirks"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></section>`;
}

function trapHtml(input: ReportInput): string {
  const acc = new Map<string, Map<string, { n: number; passed: number }>>();
  for (const g of input.grades) {
    for (const [trap, tally] of Object.entries(g.perTrap)) {
      const key = `${g.suite} / ${trap}`;
      if (!acc.has(key)) acc.set(key, new Map());
      const byModel = acc.get(key)!;
      const cur = byModel.get(g.modelId) ?? { n: 0, passed: 0 };
      cur.n += tally.n;
      cur.passed += tally.passed;
      byModel.set(g.modelId, cur);
    }
  }
  if (acc.size === 0) return "";
  const models = [...new Set(input.grades.map((g) => g.modelId))].sort();
  const head = ["suite / trap", ...models].map((h) => `<th>${esc(h)}</th>`).join("");
  const body = [...acc.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([trap, byModel]) => {
      const cells = models
        .map((m) => {
          const t = byModel.get(m);
          if (!t || t.n === 0) return `<td class="muted">—</td>`;
          const pct = (t.passed / t.n) * 100;
          return `<td class="${pct < 60 ? "bad" : pct < 90 ? "mid" : "good"}">${pct.toFixed(0)}<span class="muted"> (${t.passed}/${t.n})</span></td>`;
        })
        .join("");
      return `<tr><th class="rowhead">${esc(trap)}</th>${cells}</tr>`;
    })
    .join("");
  return `<section><h2>Breakdown by trap type</h2>
    <p class="muted">Percentage of items passed, by the trap the item was built around. This is where
    an aggregate score hides a specific weakness.</p>
    <table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></section>`;
}

function verdictHtml(verdicts: RoleVerdict[]): string {
  if (verdicts.length === 0) {
    return `<section><h2>Verdicts</h2><p class="muted">A run needs a baseline and at least one
      non-baseline candidate sharing a role before a verdict can be derived.</p></section>`;
  }
  const rows = verdicts
    .map((v) => {
      const cls = v.decision === "SWITCH" ? "switch" : "keep";
      return `<li class="verdict ${cls}">
        <span class="decision">${v.decision}</span>
        <code>${esc(v.role)}</code>
        <span>${esc(
          v.decision === "SWITCH"
            ? `${v.candidateId} from ${v.baselineId}`
            : `${v.baselineId} over ${v.candidateId}`,
        )}</span>
        <span class="muted">— ${esc(v.reason)}</span>
        ${v.tieWithinNoise ? '<span class="tag">tie within noise</span>' : ""}
        ${v.blockers.map((b) => `<span class="tag v">${esc(b)}</span>`).join("")}
        ${v.warnings.map((b) => `<span class="tag">${esc(b)}</span>`).join("")}
        ${
          v.hallucination
            ? `<span class="tag">hallucination ${v.hallucination.baseline.toFixed(1)}→${v.hallucination.candidate.toFixed(1)}/100</span>`
            : ""
        }
        ${
          v.costRatio !== null
            ? `<span class="tag">${v.costRatio.toFixed(2)}x cost</span>`
            : '<span class="tag">cost not measured</span>'
        }
      </li>`;
    })
    .join("");

  // Above the list, not inside it: an alert about the incumbent is not a fact
  // about any one comparison, and a reader who skims four KEEPs must still see it.
  const alerts = [...new Set(verdicts.map((v) => v.baselineAlert).filter((a): a is string => !!a))]
    .map((a) => `<p class="alert">‼ ${esc(a)}</p>`)
    .join("");

  return `<section><h2>Verdicts</h2>
    <p class="muted">Mechanically derived. SWITCH requires the gain to clear the confidence interval,
    no P6 blocker on a parameter the role needs, and cost within 1.1x — or a gain above 10 points.</p>
    ${alerts}
    <ul class="verdicts">${rows}</ul></section>`;
}

export function renderHtmlReport(input: ReportInput): string {
  const allRows = buildRows(input);
  // Scores and the disagreement index are computed from EVERY row, always. Only
  // what the drill-down embeds is narrowed, so no headline number moves.
  const scores = buildScores(input);
  const disagreements = buildDisagreements(scores, allRows);
  const rows = input.slim ? allRows.filter(isInteresting) : allRows;
  const omittedRows = allRows.length - rows.length;
  const m = input.manifest;

  const aggTables = [...new Set(input.aggregates.map((a) => a.suite))]
    .sort()
    .map((su) => {
      const rs = input.aggregates.filter((a) => a.suite === su);
      const keys = [...new Set(rs.flatMap((r) => Object.keys(r.metrics)))].sort();
      if (keys.length === 0) return "";
      const head = ["model", ...keys].map((h) => `<th>${esc(h)}</th>`).join("");
      const body = rs
        .map(
          (r) =>
            `<tr><th class="rowhead">${esc(r.modelId)}</th>${keys
              .map((k) => {
                const v = r.metrics[k];
                if (v === undefined) return `<td class="muted">—</td>`;
                const txt = k.startsWith("costPer")
                  ? `$${v.toFixed(v < 1 ? 3 : 2)}`
                  : k.endsWith("Ms")
                    ? `${Math.round(v)}ms`
                    : v >= 0 && v <= 1
                      ? (v * 100).toFixed(1)
                      : v.toFixed(2);
                return `<td>${txt}</td>`;
              })
              .join("")}</tr>`,
        )
        .join("");
      const notes = rs.flatMap((r) => r.notes.map((n) => `<li>${esc(r.modelId)}: ${esc(n)}</li>`));
      return `<h3>${esc(su)}</h3><table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${
        notes.length > 0 ? `<ul class="notes">${notes.join("")}</ul>` : ""
      }`;
    })
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>yardstick — run ${esc(m.runId)}</title>
<style>
:root{--bg:#fff;--fg:#16181d;--muted:#6b7280;--line:#e5e7eb;--card:#f9fafb;--accent:#1d4ed8;
--good:#047857;--mid:#b45309;--bad:#b91c1c;--baseCol:#1d4ed8;--candCol:#7c3aed}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e6e8ec;--muted:#9aa1ac;--line:#272b33;
--card:#161920;--accent:#7aa2f7;--good:#34d399;--mid:#fbbf24;--bad:#f87171;--baseCol:#7aa2f7;--candCol:#c4b5fd}}
*{box-sizing:border-box}
body{margin:0;padding:28px;background:var(--bg);color:var(--fg);
font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
h1{font-size:20px;margin:0 0 4px} h2{font-size:16px;margin:32px 0 8px;padding-top:16px;border-top:1px solid var(--line)}
h3{font-size:14px;margin:18px 0 6px} h4{font-size:13px;margin:0 0 6px;font-weight:600}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.muted{color:var(--muted)} .warn{color:var(--mid);font-size:11px}
.meta{color:var(--muted);font-size:12px;margin-bottom:6px}
table.grid{border-collapse:collapse;width:100%;margin:8px 0;font-size:13px}
table.grid th,table.grid td{border:1px solid var(--line);padding:6px 8px;text-align:right;vertical-align:top}
table.grid thead th{background:var(--card);text-align:right;font-weight:600}
table.grid th.rowhead{text-align:left;background:var(--card);white-space:nowrap}
.pill{display:inline-block;font-size:10px;padding:1px 6px;border-radius:9px;background:var(--accent);color:#fff;vertical-align:middle}
.scoreline b{font-size:15px}
.whisker{position:relative;height:6px;background:var(--line);border-radius:3px;margin-top:4px}
.whisker span{position:absolute;top:0;height:6px;background:var(--accent);opacity:.35;border-radius:3px}
.whisker i{position:absolute;top:-2px;width:2px;height:10px;background:var(--accent)}
.charts{display:flex;flex-wrap:wrap;gap:18px} .chart{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px}
svg{width:340px;height:200px} .axis{stroke:var(--line);stroke-width:1}
.tick{fill:var(--muted);font-size:9px} .lbl{fill:var(--fg);font-size:9px}
circle.base{fill:var(--baseCol)} circle.cand{fill:var(--candCol)}
td.cell{text-align:center;font-weight:600;cursor:help}
td.cell.pass{color:var(--good)} td.cell.fail{color:var(--bad)} td.cell.ignored{color:var(--mid)} td.cell.na{color:var(--muted)}
td.good{color:var(--good)} td.mid{color:var(--mid)} td.bad{color:var(--bad)}
.ties{margin:6px 0;padding-left:18px} .ties li{margin:2px 0}
b.tie{color:var(--mid)} b.sep{color:var(--good)}
.notes{color:var(--muted);font-size:12px;padding-left:18px}
.controls{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:10px 0}
select,input[type=search]{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:5px 8px;font:inherit}
label{font-size:12px;color:var(--muted);display:flex;gap:5px;align-items:center}
.item{border:1px solid var(--line);border-radius:8px;margin:8px 0;background:var(--card)}
.item>summary{cursor:pointer;padding:8px 10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.item>summary::marker{color:var(--muted)}
.sc{font-weight:700;min-width:44px;display:inline-block}
.sc.good{color:var(--good)} .sc.mid{color:var(--mid)} .sc.bad{color:var(--bad)} .sc.na{color:var(--muted)}
.tag{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:9px;padding:0 6px}
.tag.v{color:var(--bad);border-color:var(--bad)}
.alert{color:var(--bad);border:1px solid var(--bad);border-radius:6px;padding:8px 10px;margin:8px 0;font-size:13px;line-height:1.45}
.body{padding:0 12px 12px} .body h5{margin:10px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
pre{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;overflow-x:auto;font-size:12px;margin:0;white-space:pre-wrap;word-break:break-word}
ul.ev{margin:0;padding-left:18px;font-size:12px} ul.ev li{margin:1px 0}
.count{color:var(--muted);font-size:12px}
ul.verdicts{list-style:none;padding:0;margin:8px 0}
li.verdict{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin:6px 0;background:var(--card)}
li.verdict .decision{font-weight:700;font-size:12px;padding:2px 8px;border-radius:5px;color:#fff}
li.verdict.switch .decision{background:var(--good)} li.verdict.keep .decision{background:var(--muted)}
</style></head><body>

<h1>yardstick — run ${esc(m.runId)}</h1>
<div class="meta">
  ${esc(m.startedAt)} · fixtures v${esc(m.fixturesVersion)} · git ${esc(m.gitSha?.slice(0, 8) ?? "n/a")} ·
  $${m.totalCostUsd.toFixed(4)} spent · ${Math.round(m.wallMs / 1000)}s wall ·
  ${m.counts.attempts} attempts (${m.counts.cached} cached, ${m.counts.errors} errors, ${m.counts.ungraded} ungraded)
  ${m.abortedAtCap ? ' · <b class="warn">ABORTED AT SPEND CAP — results are partial</b>' : ""}
</div>

${verdictHtml(input.verdicts)}

<section><h2>Scoreboard</h2>
<p class="muted">Score 0–100 with a bootstrap 95% confidence interval over items. The bar shows the
interval; the tick shows the point estimate.</p>
${scoreboardHtml(scores)}
<h3>Is the difference real?</h3>
${tieNotes(scores)}
</section>

<section><h2>Cost vs score</h2>
<div class="charts">${scatterHtml(scores)}</div></section>

${quirksHtml(input.aggregates)}
${trapHtml(input)}

<section><h2>Suite metrics</h2>${aggTables}</section>

<section><h2>Per-item drill-down</h2>
<p class="muted">Every attempt, with the grader's verdict and evidence. Aggregate numbers you cannot
click into should not be trusted.</p>
${
  omittedRows > 0
    ? `<p class="alert">Slim report: ${omittedRows} of ${allRows.length} attempts are not listed
       below — every one of them scored a clean 1.0 with no violations. All ${allRows.length}
       contributed to every score, interval and metric on this page; only the drill-down is
       narrowed, and raw model outputs here are shortened. The full report has all of them.</p>`
    : ""
}
<div class="controls">
  <label>suite <select id="fSuite"><option value="">all</option></select></label>
  <label>model <select id="fModel"><option value="">all</option></select></label>
  <label>status <select id="fStatus"><option value="">all</option><option>graded</option><option>ungraded</option><option>error</option></select></label>
  <label><input type="checkbox" id="fViol"> only violations</label>
  <label><input type="checkbox" id="fDiff"> only where a model disagrees with the baseline</label>
  <label><input type="search" id="fText" placeholder="search item / evidence"></label>
  <span class="count" id="count"></span>
</div>
<div id="list"></div>
</section>

<script>
const ROWS = ${embed(rows)};
const DISAGREE = new Set(${embed(disagreements)});
const $ = (id) => document.getElementById(id);

for (const [sel, key] of [["fSuite","suite"],["fModel","modelId"]]) {
  const vals = [...new Set(ROWS.map(r => r[key]))].sort();
  for (const v of vals) { const o = document.createElement("option"); o.value = v; o.textContent = v; $(sel).append(o); }
}

function esc(s){return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
function cls(score,status){ if(status!=="graded"||score===null) return "na";
  return score>=0.9?"good":score>=0.6?"mid":"bad"; }

function render(){
  const su=$("fSuite").value, mo=$("fModel").value, st=$("fStatus").value;
  const onlyV=$("fViol").checked, onlyD=$("fDiff").checked, q=$("fText").value.toLowerCase();
  const out=[];
  let shown=0;
  for(const r of ROWS){
    if(su&&r.suite!==su) continue;
    if(mo&&r.modelId!==mo) continue;
    if(st&&r.status!==st) continue;
    if(onlyV&&r.violations.length===0) continue;
    if(onlyD&&!DISAGREE.has(r.suite+"\\u0000"+r.itemId)) continue;
    if(q){
      const hay=(r.itemId+" "+r.evidence.join(" ")+" "+r.output+" "+r.violations.map(v=>v.detail).join(" ")).toLowerCase();
      if(!hay.includes(q)) continue;
    }
    shown++;
    if(shown>400){ continue; }
    const sc = r.status==="graded"&&r.score!==null ? (r.score*100).toFixed(0) : r.status;
    out.push('<details class="item"><summary>'
      + '<span class="sc '+cls(r.score,r.status)+'">'+esc(sc)+'</span>'
      + '<code>'+esc(r.suite)+'/'+esc(r.itemId)+'</code>'
      + '<span class="tag">'+esc(r.modelId)+'</span>'
      + '<span class="tag">rep '+r.repeat+'</span>'
      + (r.violations.length? '<span class="tag v">'+r.violations.length+' violation'+(r.violations.length>1?'s':'')+'</span>':'')
      + (r.paramsDropped.length? '<span class="tag">dropped: '+esc(r.paramsDropped.join(","))+'</span>':'')
      + '<span class="tag">$'+r.costUsd.toFixed(5)+'</span>'
      + '<span class="tag">'+Math.round(r.latencyMs)+'ms</span>'
      + '</summary><div class="body">'
      + (r.ungradedReason? '<h5>not graded</h5><pre>'+esc(r.ungradedReason)+'</pre>':'')
      + (r.violations.length? '<h5>violations</h5><ul class="ev">'+r.violations.map(v=>'<li><b>'+esc(v.kind)+'</b>: '+esc(v.detail)+'</li>').join('')+'</ul>':'')
      + (r.evidence.length? '<h5>grader evidence</h5><ul class="ev">'+r.evidence.map(e=>'<li>'+esc(e)+'</li>').join('')+'</ul>':'')
      + '<h5>model output'+(r.outputTruncated?' (truncated)':'')+'</h5><pre>'+esc(r.output)+'</pre>'
      + '</div></details>');
  }
  $("list").innerHTML = out.join('');
  $("count").textContent = shown>400 ? ('showing first 400 of '+shown+' rows') : (shown+' rows');
}
for(const id of ["fSuite","fModel","fStatus","fViol","fDiff","fText"]) $(id).addEventListener("input",render);
render();
</script>
</body></html>`;
}
