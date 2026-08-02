import { parseQuantity } from "../graders/normalize.js";
import { normalizeWhitespace, occurrences } from "../graders/provenance.js";
import type { TrapType } from "../types.js";
import {
  FOUNDERS,
  GLOBAL_COMPANIES,
  INDIA_CITIES,
  INDIA_COMPANIES,
  INVESTORS,
  SPELLED_CRORE,
} from "./entities.js";
import { Rng } from "./rng.js";

export interface P1Fact {
  id: string;
  field: string;
  kind: "metric" | "signal";
  /** null for an absent trap: the source genuinely does not state it. */
  value: number | string | null;
  unit: string | null;
  canonical: { value: number | null; unit: string | null };
  /** null for an absent trap: there is nothing to cite. */
  quote: string | null;
  trapType: TrapType;
  note: string;
}

export interface P1Transcript {
  id: string;
  title: string;
  company: string;
  text: string;
  facts: P1Fact[];
  /** Every field the model is asked for, including the absent ones. */
  requestedFields: string[];
}

/**
 * Filler must contain no digits AND no number words, so it can never collide
 * with a planted figure or its spelled-out rendering. The uniqueness invariant
 * in transcriptProblems depends on that.
 */
const FILLER = [
  "The hiring loop is taking longer than we would like, and most of the drop-off is happening at the final onsite stage rather than earlier in the funnel.",
  "We tightened the onboarding checklist after the last cohort and the time-to-first-value has come down noticeably since then.",
  "Several enterprise accounts have asked for a full security review before they will commit to a renewal, which is adding weeks to those cycles.",
  "Support volumes have been steady and the escalation path we introduced last quarter is working much better than the old rota.",
  "We moved the weekly release window to give the QA team a clear day before anything ships to production.",
  "The design partner programme continues to be the most useful input we have for prioritising the roadmap.",
  "Our main competitor has been unusually quiet in the market, although we hear from candidates that they are rebuilding their platform.",
  "Procurement cycles in the public sector remain slow and difficult to forecast, so we have stopped putting them in the near-term pipeline.",
  "We rewrote the onboarding documentation after the last round of user interviews and the support tickets about setup have dropped away.",
  "The team offsite is booked and the agenda is mostly product strategy with a short session on operating cadence.",
  "Legal has cleared the new data processing agreement template, which should remove a recurring blocker in enterprise deals.",
  "We are consolidating tooling to reduce the number of vendor contracts we have to renew and review each year.",
  "Churn conversations are being handled by the founders directly for now, because the signal from those calls is worth the time.",
  "The engineering team has asked to reduce on-call load next quarter and we think that is reasonable given the release cadence.",
  "We have paused the partnership discussion until after the current release, mainly to avoid splitting engineering attention.",
  "Recruiting for the finance role is open and we have a shortlist, though the market for that profile is competitive.",
  "The board pack was circulated well ahead of time and we did not receive any written objections or requests for clarification.",
  "We are reviewing whether to keep the second office or move to a fully remote arrangement with quarterly gatherings.",
  "Customer advisory calls have surfaced a consistent request around reporting, which we have now put on the near-term roadmap.",
  "The migration off the legacy queue completed without incident and nothing regressed in the following release cycle.",
  "Sales cycles in the mid-market segment have shortened since we introduced the self-serve trial, which was the intended effect.",
  "We have started publishing a changelog externally and customers have responded well to the increased visibility.",
  "The account management function is still shared between the founders, which is not sustainable much beyond this year.",
  "Our infrastructure spend has been reviewed line by line and we found meaningful savings in unused reserved capacity.",
  "The compliance certification process is underway and the auditor has asked for additional evidence on access control.",
  "We have replaced the analytics stack because the previous vendor could not support the volume we now generate.",
  "Partner-sourced pipeline is growing slowly but the quality of those introductions has been consistently higher.",
  "Engineering velocity dipped during the migration and has now recovered to roughly where it was beforehand.",
  "We introduced a formal incident review process and the recurring causes have become much easier to see.",
  "The marketing site was rebuilt and organic traffic has been trending upward since the change went live.",
  "Candidate quality for senior engineering roles has improved since we started publishing more technical writing.",
  "We have moved to a quarterly planning rhythm and the teams report that priorities are clearer than before.",
  "Contract negotiations with our largest supplier are ongoing and we expect better terms given the volume commitment.",
  "The mobile experience remains a known weakness and customers mention it in almost every advisory call.",
  "We deprecated the older integration surface after giving customers a long migration window and there was little pushback.",
  "Internal tooling for the support team was built in-house, which was faster than evaluating vendors for that workflow.",
  "The data pipeline now runs on a managed service, which removed a whole class of overnight failures.",
  "We are seeing more inbound from regulated industries, which will eventually require investment in certifications.",
  "The product team has started shadowing support shifts and the roadmap conversations are better informed as a result.",
  "Localisation has come up repeatedly in the enterprise segment but we have deferred it until the core is stable.",
];

const CHAIR_LINES = [
  "Let's move to the next item.",
  "Noted. Anything else on that?",
  "Understood. Carry on.",
  "Thanks, that's helpful context.",
  "Fine. Next section.",
  "Let's come back to that at the end.",
];

interface FactPlan {
  field: string;
  kind: "metric" | "signal";
  trapType: TrapType;
}

/**
 * A fixed plan per transcript so trap coverage is guaranteed rather than
 * sampled. Index 0-24 maps to one of five rotations; each rotation exercises
 * every trap type at least once across the set.
 */
const ROTATIONS: FactPlan[][] = [
  [
    { field: "arr", kind: "metric", trapType: "unit-trap" },
    { field: "growth_yoy", kind: "metric", trapType: "distractor" },
    { field: "runway_months", kind: "metric", trapType: "stale" },
    { field: "headcount", kind: "metric", trapType: "spelled-number" },
    { field: "net_churn", kind: "metric", trapType: "absent" },
    { field: "key_hire", kind: "signal", trapType: "none" },
    { field: "fundraise_intent", kind: "signal", trapType: "none" },
    { field: "customer_loss", kind: "signal", trapType: "absent" },
  ],
  [
    { field: "arr", kind: "metric", trapType: "unit-trap" },
    { field: "gross_margin", kind: "metric", trapType: "distractor" },
    { field: "burn", kind: "metric", trapType: "unit-trap" },
    { field: "runway_months", kind: "metric", trapType: "none" },
    { field: "headcount", kind: "metric", trapType: "absent" },
    { field: "key_departure", kind: "signal", trapType: "none" },
    { field: "customer_loss", kind: "signal", trapType: "none" },
    { field: "fundraise_intent", kind: "signal", trapType: "absent" },
  ],
  [
    { field: "arr", kind: "metric", trapType: "stale" },
    { field: "growth_yoy", kind: "metric", trapType: "none" },
    { field: "headcount", kind: "metric", trapType: "spelled-number" },
    { field: "burn", kind: "metric", trapType: "none" },
    { field: "net_churn", kind: "metric", trapType: "distractor" },
    { field: "key_hire", kind: "signal", trapType: "absent" },
    { field: "customer_loss", kind: "signal", trapType: "none" },
    { field: "fundraise_intent", kind: "signal", trapType: "none" },
  ],
  [
    { field: "arr", kind: "metric", trapType: "none" },
    { field: "gross_margin", kind: "metric", trapType: "distractor" },
    { field: "runway_months", kind: "metric", trapType: "stale" },
    { field: "headcount", kind: "metric", trapType: "none" },
    { field: "burn", kind: "metric", trapType: "absent" },
    { field: "key_departure", kind: "signal", trapType: "none" },
    { field: "key_hire", kind: "signal", trapType: "none" },
    { field: "customer_loss", kind: "signal", trapType: "absent" },
  ],
  [
    { field: "arr", kind: "metric", trapType: "unit-trap" },
    { field: "growth_yoy", kind: "metric", trapType: "distractor" },
    { field: "net_churn", kind: "metric", trapType: "none" },
    { field: "runway_months", kind: "metric", trapType: "none" },
    { field: "headcount", kind: "metric", trapType: "spelled-number" },
    { field: "fundraise_intent", kind: "signal", trapType: "none" },
    { field: "key_hire", kind: "signal", trapType: "absent" },
    { field: "key_departure", kind: "signal", trapType: "absent" },
  ],
];

export const P1_METRIC_FIELDS = [
  "arr",
  "growth_yoy",
  "burn",
  "runway_months",
  "headcount",
  "net_churn",
  "gross_margin",
];
export const P1_SIGNAL_FIELDS = ["key_hire", "key_departure", "fundraise_intent", "customer_loss"];

interface Built {
  /** The sentence that states the fact. Becomes the planted quote. */
  line: string;
  fact: P1Fact;
  /** Extra sentences that create the trap (distractor / stale context). */
  extra: string[];
}

function buildMetric(rng: Rng, plan: FactPlan, id: string, india: boolean): Built | null {
  const mk = (
    line: string,
    value: number | string | null,
    unit: string | null,
    quote: string | null,
    note: string,
    extra: string[] = [],
  ): Built => {
    const canonical =
      value === null
        ? { value: null, unit: null }
        : parseQuantity(typeof value === "number" ? `${value} ${unit ?? ""}` : String(value));
    return {
      line,
      extra,
      fact: {
        id,
        field: plan.field,
        kind: "metric",
        value,
        unit,
        canonical: { value: canonical.value, unit: canonical.unit },
        quote,
        trapType: plan.trapType,
        note,
      },
    };
  };

  if (plan.trapType === "absent") {
    return mk("", null, null, null, `${plan.field} is never stated — correct answer is null`);
  }

  switch (plan.field) {
    case "arr": {
      if (india) {
        const cr = rng.int(41, 98) / 10; // one decimal, e.g. 8.1
        const other = Math.round(cr * 10 + rng.int(3, 9)) / 10; // nearby, distinct
        const quote = `we closed the quarter at an ARR of ₹${cr} crore`;
        if (plan.trapType === "stale") {
          return mk(
            `On the topline, ${quote}.`,
            cr,
            "INR crore",
            quote,
            "ARR restated later in the call; the later figure is the answer",
            [
              `Sorry, correction — the ₹${other} crore number I mentioned earlier was last quarter's.`,
            ],
          );
        }
        return mk(
          `On the topline, ${quote}.`,
          cr,
          "INR crore",
          quote,
          plan.trapType === "unit-trap" ? "ARR in crore, not dollars" : "plain ARR",
          plan.trapType === "unit-trap"
            ? [`That's separate from the ₹${other} crore Series A we banked earlier in the year.`]
            : [],
        );
      }
      const m = rng.int(21, 89) / 10;
      const quote = `ARR finished the quarter at $${m} million`;
      return mk(`On revenue, ${quote}.`, m, "USD million", quote, "ARR in USD");
    }

    case "growth_yoy": {
      const yoy = rng.int(40, 180);
      const mom = rng.int(4, 12);
      const quote = `revenue is up ${yoy}% year on year`;
      return mk(
        `Looking at growth, ${quote}.`,
        yoy,
        "%",
        quote,
        plan.trapType === "distractor"
          ? "a month-on-month figure sits nearby; the question asks for year on year"
          : "plain YoY growth",
        plan.trapType === "distractor" ? [`Month on month we're running at about ${mom}%.`] : [],
      );
    }

    case "gross_margin": {
      const gm = rng.int(58, 84);
      const pp = rng.int(2, 7);
      const quote = `gross margin came in at ${gm}%`;
      return mk(
        `On unit economics, ${quote}.`,
        gm,
        "%",
        quote,
        plan.trapType === "distractor"
          ? "a percentage-point movement sits nearby; percent and pp are different units"
          : "plain gross margin",
        plan.trapType === "distractor"
          ? [`That's an improvement of ${pp} percentage points on the prior quarter.`]
          : [],
      );
    }

    case "burn": {
      if (india) {
        const lakh = rng.int(35, 120);
        const quote = `net burn is running at ₹${lakh} lakh a month`;
        return mk(`On cash, ${quote}.`, lakh, "INR lakh", quote, "burn in lakh per month");
      }
      const k = rng.int(120, 480);
      const quote = `net burn is about $${k}k a month`;
      return mk(`On cash, ${quote}.`, k, "USD thousand", quote, "burn in USD thousands");
    }

    case "runway_months": {
      const now = rng.int(11, 26);
      const before = rng.int(5, 9);
      if (plan.trapType === "stale") {
        const quote = `after the bridge we're at ${numberWord(now)} months`;
        return mk(
          `We said ${numberWord(before)} months of runway at the last board, but ${quote}.`,
          now,
          "months",
          quote,
          "an earlier runway figure is superseded in the same sentence",
        );
      }
      const quote = `that gives us ${numberWord(now)} months of runway`;
      return mk(`On the balance sheet, ${quote}.`, now, "months", quote, "plain runway");
    }

    case "headcount": {
      const n = rng.int(23, 96);
      if (plan.trapType === "spelled-number") {
        const spelled = numberWord(n);
        const quote = `the team is at about ${spelled} people now`;
        return mk(`On the org, ${quote}.`, n, "people", quote, "headcount spelled out");
      }
      const quote = `we're at ${n} people across both offices`;
      return mk(`On the org, ${quote}.`, n, "people", quote, "plain headcount");
    }

    case "net_churn": {
      const churn = rng.int(1, 9) + rng.int(0, 9) / 10;
      const logo = rng.int(10, 22);
      const quote = `net revenue churn was ${churn}% for the quarter`;
      return mk(
        `On retention, ${quote}.`,
        churn,
        "%",
        quote,
        plan.trapType === "distractor"
          ? "a logo-churn figure sits nearby; the question asks for revenue churn"
          : "plain net revenue churn",
        plan.trapType === "distractor" ? [`Logo churn was higher at ${logo}%.`] : [],
      );
    }

    default:
      return null;
  }
}

function buildSignal(rng: Rng, plan: FactPlan, id: string): Built | null {
  const mk = (line: string, value: string | null, quote: string | null, note: string): Built => ({
    line,
    extra: [],
    fact: {
      id,
      field: plan.field,
      kind: "signal",
      value,
      unit: null,
      canonical: { value: null, unit: null },
      quote,
      trapType: plan.trapType,
      note,
    },
  });

  if (plan.trapType === "absent") {
    return mk("", null, null, `${plan.field} is never mentioned — correct answer is null`);
  }

  const person = rng.pick(FOUNDERS);
  switch (plan.field) {
    case "key_hire": {
      const role = rng.pick(["VP Engineering", "Head of Sales", "VP Finance", "Head of Product"]);
      const quote = `we've signed ${person} as ${role}, starting next month`;
      return mk(`On senior hiring, ${quote}.`, `${person} joining as ${role}`, quote, "key hire");
    }
    case "key_departure": {
      const role = rng.pick(["head of sales", "engineering lead", "finance lead"]);
      const quote = `${person}, our ${role}, is leaving at the end of the quarter`;
      return mk(
        `One difficult item — ${quote}.`,
        `${person} departing (${role})`,
        quote,
        "key departure",
      );
    }
    case "fundraise_intent": {
      const stage = rng.pick(["Series A", "Series B", "Series C"]);
      const quarter = rng.pick(["Q2", "Q3", "Q4"]);
      const quote = `we want to start the ${stage} conversation in ${quarter}`;
      return mk(
        `On financing, ${quote}.`,
        `${stage} planned for ${quarter}`,
        quote,
        "fundraise intent",
      );
    }
    case "customer_loss": {
      const customer = rng.pick(GLOBAL_COMPANIES).name;
      const quote = `${customer} confirmed they will not renew`;
      return mk(`On the pipeline, ${quote}.`, `${customer} not renewing`, quote, "customer loss");
    }
    default:
      return null;
  }
}

const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function numberWord(n: number): string {
  if (n < 20) return WORDS[n] ?? String(n);
  const t = Math.floor(n / 10);
  const u = n % 10;
  const tens = TENS[t] ?? String(n);
  return u === 0 ? tens : `${tens}-${WORDS[u]}`;
}

function buildTranscript(rng: Rng, index: number): P1Transcript {
  const rotation = ROTATIONS[index % ROTATIONS.length]!;
  const india = index % 3 !== 2;
  const company = india
    ? INDIA_COMPANIES[index % INDIA_COMPANIES.length]!
    : GLOBAL_COMPANIES[index % GLOBAL_COMPANIES.length]!;
  const founder = FOUNDERS[index % FOUNDERS.length]!;
  const cofounder = FOUNDERS[(index + 4) % FOUNDERS.length]!;
  const investor = INVESTORS[index % INVESTORS.length]!;
  const chair = FOUNDERS[(index + 7) % FOUNDERS.length]!;
  const city = india ? INDIA_CITIES[index % INDIA_CITIES.length]! : "Lisbon";
  const id = `p1-${String(index + 1).padStart(3, "0")}`;

  const built: Built[] = [];
  let factNo = 0;
  for (const plan of rotation) {
    factNo++;
    const b =
      plan.kind === "metric"
        ? buildMetric(rng, plan, `${id}-f${factNo}`, india)
        : buildSignal(rng, plan, `${id}-f${factNo}`);
    if (b) built.push(b);
  }

  // Interleave: fact lines carried by the founders, filler and chair prompts
  // between them, so quotes are never adjacent and a wrong-section citation is
  // a realistic mistake rather than an impossible one.
  const speakers = [founder.toUpperCase(), cofounder.toUpperCase()];
  const turns: string[] = [];
  turns.push(
    `Board call — ${company.name} — quarterly review`,
    `Location: ${city}. Attendees: ${founder} (CEO), ${cofounder} (COO), ${chair} (chair), ${investor} (investor).`,
    "",
  );

  const fillerPool = rng.shuffle(FILLER);
  let fillerIdx = 0;
  const nextFiller = () => fillerPool[fillerIdx++ % fillerPool.length]!;

  // Transcript length is varied across the set (roughly 3k to 8k tokens) so the
  // suite exercises short and long context, not one convenient size.
  const fillerTurnsPerFact = 4 + (index % 4) * 2; // 4, 6, 8, 10

  let speakerIdx = 0;
  for (const b of built) {
    for (let i = 0; i < fillerTurnsPerFact; i++) {
      const sp = speakers[speakerIdx++ % speakers.length]!;
      turns.push(`${sp}: ${nextFiller()} ${nextFiller()} ${nextFiller()}`);
    }
    turns.push(`${chair.toUpperCase()}: ${rng.pick(CHAIR_LINES)}`);
    if (b.line !== "") {
      const sp = speakers[speakerIdx++ % speakers.length]!;
      turns.push(`${sp}: ${b.line}${b.extra.length > 0 ? ` ${b.extra.join(" ")}` : ""}`);
    }
  }
  for (let i = 0; i < 4; i++) {
    const sp = speakers[speakerIdx++ % speakers.length]!;
    turns.push(`${sp}: ${nextFiller()} ${nextFiller()} ${nextFiller()}`);
  }
  turns.push(`${chair.toUpperCase()}: That covers the agenda. We'll reconvene next quarter.`);

  const text = turns.join("\n\n");
  const facts = built.map((b) => b.fact);

  return {
    id,
    title: `${company.name} quarterly board call`,
    company: company.name,
    text,
    facts,
    requestedFields: [...P1_METRIC_FIELDS, ...P1_SIGNAL_FIELDS],
  };
}

export interface P1Fixtures {
  transcripts: P1Transcript[];
}

/**
 * Generate, then verify by construction. A transcript that fails the invariants
 * is re-rolled with a fresh sub-seed rather than shipped — a fixture whose
 * planted quote does not appear verbatim would make every provenance score a lie.
 */
export function generateP1(seed: number, count = 25): P1Fixtures {
  const transcripts: P1Transcript[] = [];
  for (let i = 0; i < count; i++) {
    let ok = false;
    let lastProblems: string[] = [];
    for (let attempt = 0; attempt < 40 && !ok; attempt++) {
      const rng = new Rng(seed + i * 1000 + attempt);
      const t = buildTranscript(rng, i);
      lastProblems = transcriptProblems(t);
      if (lastProblems.length === 0) {
        transcripts.push(t);
        ok = true;
      }
    }
    if (!ok) {
      // Say WHY. A collision is fixable by re-rolling; a length problem is
      // deterministic and means the generator itself needs changing.
      throw new Error(
        `p1: no clean transcript for index ${i} after 40 re-rolls.\n` +
          `  last attempt's problems:\n    ${lastProblems.join("\n    ")}`,
      );
    }
  }
  return { transcripts };
}

/** The by-construction guarantees. Empty array means the fixture is sound. */
export function transcriptProblems(t: P1Transcript): string[] {
  const problems: string[] = [];
  const norm = normalizeWhitespace(t.text);

  for (const f of t.facts) {
    if (f.trapType === "absent") {
      if (f.quote !== null || f.value !== null) {
        problems.push(`${f.id}: absent trap must have null value and quote`);
      }
      continue;
    }
    if (!f.quote) {
      problems.push(`${f.id}: missing quote`);
      continue;
    }
    const n = occurrences(norm, f.quote);
    if (n === 0) problems.push(`${f.id}: planted quote does not survive verbatim`);
    if (n > 1)
      problems.push(`${f.id}: planted quote appears ${n} times — citation would be ambiguous`);
  }

  // Every planted numeric rendering must be unique in the document, or a
  // correct-looking quote could point at the wrong occurrence.
  for (const f of t.facts) {
    if (f.kind !== "metric" || f.value === null) continue;
    const rendering = renderingOf(f);
    if (rendering === null) continue;
    const n = occurrences(norm, rendering);
    if (n !== 1) {
      problems.push(`${f.id}: numeric rendering "${rendering}" appears ${n} times, want exactly 1`);
    }
  }

  // 3-8k tokens at roughly 1.4 tokens/word is about 2,100-5,700 words.
  const words = norm.split(/\s+/).length;
  if (words < 2000) problems.push(`transcript too short: ${words} words, want >= 2000`);
  if (words > 6200) problems.push(`transcript too long: ${words} words, want <= 6200`);

  return problems;
}

/** The exact substring the number is written as, for the uniqueness check. */
function renderingOf(f: P1Fact): string | null {
  if (typeof f.value !== "number") return null;
  if (f.unit === "INR crore") return `₹${f.value} crore`;
  if (f.unit === "INR lakh") return `₹${f.value} lakh`;
  if (f.unit === "USD million") return `$${f.value} million`;
  if (f.unit === "USD thousand") return `$${f.value}k`;
  if (f.unit === "%") return `${f.value}%`;
  if (f.unit === "months") return `${numberWord(f.value)} months`;
  if (f.unit === "people") {
    return f.trapType === "spelled-number" ? `${numberWord(f.value)} people` : `${f.value} people`;
  }
  return null;
}
