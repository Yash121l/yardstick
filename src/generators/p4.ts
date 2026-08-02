import {
  FOUNDERS,
  GLOBAL_COMPANIES,
  INDIA_CITIES,
  INDIA_COMPANIES,
  INVESTORS,
} from "./entities.js";
import { Rng } from "./rng.js";

/**
 * P4 fixture packs: the raw material an IC memo, a delta brief and a digest
 * email would all be written from.
 *
 * Every number that appears anywhere in a pack is recorded, because the
 * deterministic grader checks that no number in the OUTPUT is absent from the
 * pack. A figure the writer produced from nowhere is an invented fact.
 */

export type DocType = "ic-memo" | "delta-brief" | "digest-email";

export interface NewsItem {
  /** Short label for the report. */
  key: string;
  /**
   * Distinctive tokens that a faithful mention of this item would contain.
   *
   * Matching on the label ("senior departure") missed a delta brief that plainly
   * reported the departure by name, and would equally have missed a
   * re-litigation — a false negative on the check that matters most. Each token
   * is asserted to appear exactly once in the pack, so a hit is unambiguous.
   */
  detect: string[];
  text: string;
  /** True when the IC has already been told about this. */
  previouslyReported: boolean;
}

export interface P4Pack {
  id: string;
  company: string;
  sector: string;
  city: string;
  /** The rendered pack the model is given. */
  text: string;
  news: NewsItem[];
  previouslyReported: string[];
  /** Canonical numbers appearing anywhere in the pack, for traceability. */
  numbers: { raw: string; canonicalValue: number; canonicalUnit: string }[];
}

export const IC_MEMO_SECTIONS = [
  "Recommendation",
  "Company",
  "Team",
  "Market",
  "Product & moat",
  "Traction",
  "Deal",
  "Risks & open questions",
  "Return scenarios",
];

/** Hard caps. Crisp beats comprehensive; a memo that runs long is a failure. */
export const LENGTH_CAPS: Record<DocType, number> = {
  "ic-memo": 900,
  "delta-brief": 260,
  "digest-email": 220,
};

const NEWS_TEMPLATES: ((
  co: string,
  rng: Rng,
) => { key: string; detect: string[]; text: string })[] = [
  (co) => ({
    key: "hiring freeze",
    detect: ["non-engineering"],
    text: `${co} has paused all non-engineering hiring for the current quarter, according to a note circulated to shareholders.`,
  }),
  (co, rng) => ({
    key: "regional expansion",
    detect: ["second office"],
    text: `${co} opened a second office in ${rng.pick(INDIA_CITIES)} to serve customers outside its home market.`,
  }),
  (co, rng) => ({
    key: "competitor raise",
    detect: ["competitor"],
    text: `A direct competitor to ${co} announced a large growth round led by ${rng.pick(INVESTORS)}.`,
  }),
  (co) => ({
    key: "certification",
    detect: ["SOC 2"],
    text: `${co} completed its SOC 2 Type II certification, removing a blocker that had stalled several enterprise deals.`,
  }),
  (co) => ({
    key: "pricing change",
    detect: ["usage-based"],
    text: `${co} moved from seat-based to usage-based pricing across its self-serve tier.`,
  }),
  (co, rng) => {
    const who = rng.pick(FOUNDERS);
    return {
      key: "senior departure",
      detect: [who.split(" ")[1] ?? who],
      text: `${who}, who led revenue at ${co}, has left the company.`,
    };
  },
  (co) => ({
    key: "platform outage",
    detect: ["outage"],
    text: `${co} suffered a multi-hour outage that affected its largest enterprise accounts.`,
  }),
  (co, rng) => ({
    key: "channel partnership",
    detect: ["reseller"],
    text: `${co} signed a reseller agreement with a systems integrator covering the ${rng.pick(["public sector", "manufacturing", "healthcare"])} segment.`,
  }),
];

function numberWord(n: number): string {
  return String(n);
}

export function generateP4(seed: number, count = 12): P4Pack[] {
  const rng = new Rng(seed);
  const packs: P4Pack[] = [];
  const pool = [...INDIA_COMPANIES, ...GLOBAL_COMPANIES];

  for (let i = 0; i < count; i++) {
    const base = pool[i % pool.length]!;
    const india = base.india;
    const city = india ? rng.pick(INDIA_CITIES) : "Lisbon";
    const founder = FOUNDERS[i % FOUNDERS.length]!;
    const cofounder = FOUNDERS[(i + 3) % FOUNDERS.length]!;
    const investor = rng.pick(INVESTORS);
    const id = `p4-${String(i + 1).padStart(3, "0")}`;

    // Metrics. Every one of these is a number the writer MAY use.
    const arr = rng.int(31, 96) / 10;
    const growth = rng.int(35, 190);
    const burn = rng.int(28, 140);
    const runway = rng.int(9, 31);
    const headcount = rng.int(18, 140);
    const nrr = rng.int(88, 137);
    const grossMargin = rng.int(56, 84);
    const customers = rng.int(24, 310);
    const askUsd = rng.int(3, 18);
    const ownership = rng.int(8, 19);

    const numbers: P4Pack["numbers"] = [];
    const rec = (raw: string, canonicalValue: number, canonicalUnit: string) =>
      numbers.push({ raw, canonicalValue, canonicalUnit });

    const money = (v: number) => (india ? `₹${v} crore` : `$${v} million`);
    rec(money(arr), india ? arr * 1e7 : arr * 1e6, india ? "INR" : "USD");
    rec(`${growth}%`, growth, "pct");
    rec(
      india ? `₹${burn} lakh` : `$${burn}k`,
      india ? burn * 1e5 : burn * 1e3,
      india ? "INR" : "USD",
    );
    rec(`${runway} months`, runway, "months");
    rec(`${headcount}`, headcount, "count");
    rec(`${nrr}%`, nrr, "pct");
    rec(`${grossMargin}%`, grossMargin, "pct");
    rec(`${customers}`, customers, "count");
    rec(`$${askUsd} million`, askUsd * 1e6, "USD");
    rec(`${ownership}%`, ownership, "pct");

    // Three news items; the first is already known to the IC.
    const chosen = rng.sample(NEWS_TEMPLATES, 3).map((t) => t(base.name, rng));
    const news: NewsItem[] = chosen.map((c, idx) => ({
      key: c.key,
      detect: c.detect,
      text: c.text,
      previouslyReported: idx === 0,
    }));

    // Two further things the IC already knows that are NOT in the news list.
    const priorOnly = [
      `${base.name} closed its seed round led by ${investor}.`,
      `${base.name} appointed ${cofounder} as ${rng.pick(["COO", "VP Product", "Head of Data"])}.`,
    ];
    const previouslyReported = [chosen[0]!.text, ...priorOnly];

    const text = [
      `# Pack — ${base.name}`,
      "",
      `${base.name} is a ${base.sector} company based in ${city}. ${base.oneLiner}.`,
      "",
      "## Metrics (latest quarter)",
      `- ARR: ${money(arr)}`,
      `- Growth, year on year: ${growth}%`,
      `- Net burn: ${india ? `₹${burn} lakh` : `$${burn}k`} per month`,
      `- Runway: ${runway} months`,
      `- Headcount: ${numberWord(headcount)}`,
      `- Net revenue retention: ${nrr}%`,
      `- Gross margin: ${grossMargin}%`,
      `- Paying customers: ${numberWord(customers)}`,
      "",
      "## Deal",
      `- Raising: $${askUsd} million`,
      `- Ownership on offer: ${ownership}%`,
      "",
      "## Transcript excerpt — board call",
      `${founder.toUpperCase()}: Retention is the thing we are proudest of this quarter. The expansion motion inside existing accounts is finally working, and that is what is carrying net revenue retention.`,
      `${cofounder.toUpperCase()}: The counterweight is that new logo acquisition slowed. We are relying more on expansion than we would like, and the top of the funnel needs work before the next raise.`,
      "",
      "## Transcript excerpt — founder catch-up",
      `${founder.toUpperCase()}: Hiring is the bottleneck. We have the budget signed off but the senior engineering market is brutal and we have lost two candidates at offer stage.`,
      `${founder.toUpperCase()}: On the product side, the reporting module is what customers ask for in every single advisory call. It is now the next thing we build.`,
      "",
      "## Recent news",
      ...news.map((n, idx) => `${idx + 1}. ${n.text}`),
      "",
      "## Previously reported to the investment committee",
      ...previouslyReported.map((p) => `- ${p}`),
    ].join("\n");

    packs.push({
      id,
      company: base.name,
      sector: base.sector,
      city,
      text,
      news,
      previouslyReported,
      numbers,
    });
  }

  return packs;
}

export function assertP4Invariants(packs: P4Pack[]): void {
  const errs: string[] = [];
  for (const p of packs) {
    if (p.news.length !== 3) errs.push(`${p.id}: expected 3 news items`);
    if (p.news.filter((n) => n.previouslyReported).length !== 1) {
      errs.push(`${p.id}: expected exactly 1 previously-reported news item`);
    }
    if (p.previouslyReported.length !== 3)
      errs.push(`${p.id}: expected 3 previously-reported lines`);
    if (p.numbers.length < 8) errs.push(`${p.id}: too few recorded numbers`);
    // Every recorded number must actually be in the rendered pack, or the
    // traceability grader would reject a legitimate figure.
    for (const n of p.numbers) {
      if (!p.text.includes(n.raw)) {
        errs.push(`${p.id}: recorded number "${n.raw}" is not present in the pack text`);
      }
    }
    // A detect token must appear only where it is supposed to: once in the
    // news list, plus once more in the previously-reported list for the item
    // that is deliberately duplicated there. Any other count means a hit could
    // come from unrelated prose and the delta checks would be unreliable.
    for (const n of p.news) {
      const want = n.previouslyReported ? 2 : 1;
      for (const d of n.detect) {
        const count = countTokens(p.text, d);
        if (count !== want) {
          errs.push(`${p.id}: detect token "${d}" appears ${count} times, want ${want}`);
        }
      }
    }
    const words = p.text.split(/\s+/).length;
    if (words < 180) errs.push(`${p.id}: pack too thin (${words} words)`);
  }
  if (errs.length > 0) throw new Error(`P4 fixtures are unsound:\n  ${errs.join("\n  ")}`);
}

/** Word-boundary count, so "outage" never matches inside another word. */
export function countTokens(hay: string, needle: string): number {
  const escaped = needle.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (hay.match(new RegExp(`(?<![\\w])${escaped}(?![\\w])`, "gi")) ?? []).length;
}

/** True when the text mentions the news item at all. */
export function mentionsNews(text: string, item: NewsItem): boolean {
  return item.detect.some((d) => countTokens(text, d) > 0);
}
