import type { TrapType } from "../types.js";
import {
  COLLISION_PAIRS,
  FOUNDERS,
  GLOBAL_CITIES,
  GLOBAL_COMPANIES,
  INDIA_CITIES,
  INDIA_COMPANIES,
  INVESTORS,
  ROUND_STAGES,
  type RoundStage,
  SPELLED_CRORE,
} from "./entities.js";
import { Rng } from "./rng.js";

export type LabelSet = "funding" | "meeting" | "signal" | "thesis";

export interface P2Item {
  id: string;
  labelSet: LabelSet;
  text: string;
  trapType: TrapType;
  /** What the trap is, surfaced in the report drill-down. */
  note: string;
}

export interface P2Gold {
  id: string;
  labelSet: LabelSet;
  labels: Record<string, string | boolean | null>;
}

/** Stated once in the prompt; all `signal` items are judged against it. */
export const WATCHLIST = [
  "Brightloom Kirana",
  "Banyan Ledger",
  "Monsoon Metrics",
  "Zephyrwick Analytics",
  "Quillstone Systems",
  "Kolam Health",
];

/** Stated once in the prompt; all `thesis` items are judged against it. */
export const THESIS = [
  "We back early-stage B2B software companies in India and Europe that sell to",
  "mid-market operators, with a bias toward vertical SaaS and developer",
  "infrastructure. We do not invest in consumer social, crypto, or",
  "hardware-first businesses.",
].join(" ");

const MEETING_CLASSES = ["board-call", "founder-catchup", "internal", "external-other"] as const;

/* ------------------------------------------------------------------ *
 * (a) funding news
 * ------------------------------------------------------------------ */

function fundingItems(rng: Rng): { items: P2Item[]; gold: P2Gold[] } {
  const items: P2Item[] = [];
  const gold: P2Gold[] = [];
  let n = 0;
  const id = () => `p2-a-${String(++n).padStart(3, "0")}`;

  const push = (
    text: string,
    labels: { is_funding_event: boolean; round_stage: RoundStage | null; is_india: boolean },
    trapType: TrapType,
    note: string,
  ) => {
    const itemId = id();
    items.push({ id: itemId, labelSet: "funding", text, trapType, note });
    gold.push({ id: itemId, labelSet: "funding", labels: { ...labels } });
  };

  // --- 8 plain events, alternating India / non-India, INR / USD sensibly ---
  for (let i = 0; i < 8; i++) {
    const india = i % 2 === 0;
    const co = india
      ? INDIA_COMPANIES[i % INDIA_COMPANIES.length]!
      : GLOBAL_COMPANIES[i % GLOBAL_COMPANIES.length]!;
    const city = india ? rng.pick(INDIA_CITIES) : rng.pick(GLOBAL_CITIES);
    const stage = ROUND_STAGES[i % ROUND_STAGES.length]!;
    const investor = rng.pick(INVESTORS);
    const amount = india ? `₹${rng.int(8, 90)} crore` : `$${rng.int(3, 40)} million`;
    const shape = i % 3;
    const text =
      shape === 0
        ? `${co.name}, the ${city}-based ${co.sector} startup, has raised ${amount} in a ${stage} round led by ${investor}.`
        : shape === 1
          ? `${investor} has led a ${amount} ${stage} investment in ${co.name}, a ${co.sector} company headquartered in ${city}.`
          : `${co.name} (${city}) announced the close of its ${stage} round at ${amount}, with participation from ${investor}.`;
    push(
      text,
      { is_funding_event: true, round_stage: stage, is_india: india },
      "none",
      "plain funding event",
    );
  }

  // --- 10 non-events that use funding vocabulary ---
  const nonEventShapes = [
    (co: string, city: string, who: string, inv: string) =>
      `${co}'s founder ${who} will keynote the ${inv} Growth Summit in ${city} next month.`,
    (co: string, _city: string, _who: string, inv: string) =>
      `${co} is reportedly in early talks with ${inv} about a future round, according to people familiar with the matter. Nothing has been signed.`,
    (co: string, _city: string, _who: string, inv: string) =>
      `${co} announced a distribution partnership with ${inv} Ventures' portfolio company; financial terms were not disclosed.`,
    (co: string, _city: string, who: string, _inv: string) =>
      `${co} has appointed ${who} as head of finance, a hire the company says will prepare it for an eventual institutional round.`,
    (co: string, city: string, _who: string, _inv: string) =>
      `${co} opened a second engineering office in ${city}, doubling headcount there over the past year.`,
  ];
  for (let i = 0; i < 10; i++) {
    const india = i % 2 === 0;
    const co = india
      ? INDIA_COMPANIES[(i + 3) % INDIA_COMPANIES.length]!
      : GLOBAL_COMPANIES[(i + 2) % GLOBAL_COMPANIES.length]!;
    const city = india ? rng.pick(INDIA_CITIES) : rng.pick(GLOBAL_CITIES);
    const shape = nonEventShapes[i % nonEventShapes.length]!;
    push(
      shape(co.name, city, rng.pick(FOUNDERS), rng.pick(INVESTORS)),
      { is_funding_event: false, round_stage: null, is_india: india },
      "distractor",
      "funding-adjacent vocabulary, no completed round",
    );
  }

  // --- 8 currency/HQ mismatches: is_india must follow HQ, not the currency sign ---
  for (let i = 0; i < 8; i++) {
    const inrForGlobal = i % 2 === 0;
    const stage = ROUND_STAGES[i % ROUND_STAGES.length]!;
    const investor = rng.pick(INVESTORS);
    if (inrForGlobal) {
      const co = GLOBAL_COMPANIES[i % GLOBAL_COMPANIES.length]!;
      const city = rng.pick(GLOBAL_CITIES);
      push(
        `${co.name}, headquartered in ${city}, raised ₹${rng.int(40, 200)} crore in a ${stage} round from India-focused ${investor}. The company has no India operations.`,
        { is_funding_event: true, round_stage: stage, is_india: false },
        "unit-trap",
        "INR crore amount, non-India company",
      );
    } else {
      const co = INDIA_COMPANIES[i % INDIA_COMPANIES.length]!;
      const city = rng.pick(INDIA_CITIES);
      push(
        `${co.name}, which operates entirely out of ${city}, closed a $${rng.int(4, 30)} million ${stage} round led by ${investor}.`,
        { is_funding_event: true, round_stage: stage, is_india: true },
        "unit-trap",
        "USD amount, India-headquartered company",
      );
    }
  }

  // --- 5 spelled-out amounts ---
  const croreKeys = Object.keys(SPELLED_CRORE).map(Number);
  for (let i = 0; i < 5; i++) {
    const co = INDIA_COMPANIES[(i + 5) % INDIA_COMPANIES.length]!;
    const stage = ROUND_STAGES[(i + 1) % ROUND_STAGES.length]!;
    const amt = SPELLED_CRORE[croreKeys[i % croreKeys.length]!]!;
    push(
      `${co.name} has raised about ${amt} in a ${stage} round, its first institutional cheque, from ${rng.pick(INVESTORS)}. The ${rng.pick(INDIA_CITIES)} company will use it to expand its ${co.sector} team.`,
      { is_funding_event: true, round_stage: stage, is_india: true },
      "spelled-number",
      "amount spelled out in Indian numbering",
    );
  }

  // --- 7 real events with the stage genuinely undisclosed ---
  for (let i = 0; i < 7; i++) {
    const india = i % 2 === 0;
    const co = india
      ? INDIA_COMPANIES[(i + 7) % INDIA_COMPANIES.length]!
      : GLOBAL_COMPANIES[(i + 5) % GLOBAL_COMPANIES.length]!;
    const city = india ? rng.pick(INDIA_CITIES) : rng.pick(GLOBAL_CITIES);
    push(
      `${co.name} (${city}) has closed a new funding round led by ${rng.pick(INVESTORS)}. The company declined to disclose the stage or the amount.`,
      { is_funding_event: true, round_stage: null, is_india: india },
      "absent",
      "genuine event, stage never stated — correct answer is null",
    );
  }

  return { items, gold };
}

/* ------------------------------------------------------------------ *
 * (a2) entity-collision items, appended to the funding set
 * ------------------------------------------------------------------ */

function collisionItems(rng: Rng, startIndex: number): { items: P2Item[]; gold: P2Gold[] } {
  const items: P2Item[] = [];
  const gold: P2Gold[] = [];
  let n = startIndex;

  for (const pair of COLLISION_PAIRS) {
    const itemId = `p2-a-${String(++n).padStart(3, "0")}`;
    const stage = rng.pick([...ROUND_STAGES]);
    // The FUNDED entity is the collider; the similarly-named subject is only
    // mentioned. is_india must follow the funded entity.
    const funded = pair.collider;
    const fundedIndia = !pair.india;
    const city = fundedIndia ? rng.pick(INDIA_CITIES) : rng.pick(GLOBAL_CITIES);
    const otherCity = pair.india ? rng.pick(INDIA_CITIES) : rng.pick(GLOBAL_CITIES);
    const text =
      `${funded}, based in ${city}, raised $${rng.int(5, 25)} million in a ${stage} round led by ${rng.pick(INVESTORS)}. ` +
      `The round is unrelated to ${otherCity}-based ${pair.subject}, a separate company with a similar name.`;
    items.push({
      id: itemId,
      labelSet: "funding",
      text,
      trapType: "distractor",
      note: `entity collision: ${funded} funded, ${pair.subject} merely mentioned`,
    });
    gold.push({
      id: itemId,
      labelSet: "funding",
      labels: { is_funding_event: true, round_stage: stage, is_india: fundedIndia },
    });
  }
  return { items, gold };
}

/* ------------------------------------------------------------------ *
 * (b) meeting classification
 * ------------------------------------------------------------------ */

function meetingItems(rng: Rng): { items: P2Item[]; gold: P2Gold[] } {
  const items: P2Item[] = [];
  const gold: P2Gold[] = [];
  let n = 0;
  const push = (
    title: string,
    snippet: string,
    label: string,
    trapType: TrapType,
    note: string,
  ) => {
    const itemId = `p2-b-${String(++n).padStart(3, "0")}`;
    items.push({
      id: itemId,
      labelSet: "meeting",
      text: `Title: ${title}\nNotes: ${snippet}`,
      trapType,
      note,
    });
    gold.push({ id: itemId, labelSet: "meeting", labels: { meeting_type: label } });
  };

  // 24 unambiguous, 6 per class
  for (let i = 0; i < 6; i++) {
    const co = rng.pick([...INDIA_COMPANIES, ...GLOBAL_COMPANIES]);
    push(
      `Q${(i % 4) + 1} Board Meeting — ${co.name}`,
      `Quarterly board review. Deck circulated in advance; approved the revised operating plan and two board resolutions. Attendees: full board plus ${rng.pick(FOUNDERS)}.`,
      "board-call",
      "none",
      "formal quarterly board meeting",
    );
  }
  for (let i = 0; i < 6; i++) {
    const co = rng.pick(INDIA_COMPANIES);
    push(
      `Catch-up: ${rng.pick(FOUNDERS)} (${co.name})`,
      `Informal monthly check-in with the founder of an existing portfolio company. Talked through hiring, a churned account, and the next fundraise timeline. No deck, no resolutions.`,
      "founder-catchup",
      "none",
      "informal check-in with a portfolio founder",
    );
  }
  for (let i = 0; i < 6; i++) {
    push(
      rng.pick([
        "Weekly Investment Team Sync",
        "Pipeline Standup",
        "Internal Portfolio Review",
        "Fund Ops — Monthly Close",
        "Team Offsite Planning",
        "Internal: LP Reporting Prep",
      ]),
      `Firm-internal session. Attendees are all members of the investment team. Went through the pipeline and assigned follow-ups. No external participants.`,
      "internal",
      "none",
      "firm-internal meeting only",
    );
  }
  for (let i = 0; i < 6; i++) {
    push(
      rng.pick([
        `Intro call: ${rng.pick(INVESTORS)}`,
        "Vendor demo — data provider",
        "LP update call",
        "Conference debrief",
        `Coffee: ${rng.pick(FOUNDERS)} (not a portfolio company)`,
        "Auditor walkthrough",
      ]),
      `External participant who is not a portfolio founder. Coverage of general market topics; no portfolio company governance discussed.`,
      "external-other",
      "none",
      "external, non-portfolio-founder",
    );
  }

  // 16 traps — the title points one way, the content another
  const traps: { title: string; snippet: string; label: string; note: string }[] = [
    {
      title: "Board deck prep — internal only",
      snippet:
        "Investment team only. Drafted the slides we will present at next week's board meeting. No founder or independent director present.",
      label: "internal",
      note: 'title says "board", meeting is internal prep',
    },
    {
      title: "Founder intro — Harrowgate Freight",
      snippet:
        "First time meeting this founder, sourced through a warm intro. Not a portfolio company; evaluating whether to take a second meeting.",
      label: "external-other",
      note: 'title says "founder", but not a portfolio founder',
    },
    {
      title: "Sync with Anaya Vermillion",
      snippet:
        "Monthly check-in with the founder of Brightloom Kirana, an existing portfolio company. Discussed runway and a senior hire. Informal, no board pack.",
      label: "founder-catchup",
      note: "neutral title, content identifies a portfolio catch-up",
    },
    {
      title: "Brightloom Kirana — quarterly",
      snippet:
        "Formal session with the full board including both independent directors. Approved the annual budget and recorded a resolution on the ESOP pool.",
      label: "board-call",
      note: "informal title, formal board content",
    },
    {
      title: "Portfolio review",
      snippet:
        "Internal only. Went company by company through the portfolio and updated our own marks. No founders attended.",
      label: "internal",
      note: '"portfolio" in title but no external attendee',
    },
    {
      title: "Board observer sync — Banyan Ledger",
      snippet:
        "Our board observer briefed the internal team on what happened at last week's board meeting. No company representatives attended this session.",
      label: "internal",
      note: "a debrief ABOUT a board call is not a board call",
    },
    {
      title: "Catch-up: Tobias Rennick",
      snippet:
        "Founder of a company we passed on two years ago. Keeping the relationship warm; he is now raising again elsewhere.",
      label: "external-other",
      note: "catch-up with a non-portfolio founder",
    },
    {
      title: "Emergency board call — Kolam Health",
      snippet:
        "Unscheduled board session called by the chair to approve bridge financing. Full board attended and a resolution was passed.",
      label: "board-call",
      note: "unscheduled but genuinely a board call",
    },
    {
      title: "Weekly sync — Monsoon Metrics",
      snippet:
        "Recurring informal call with the founding team of a portfolio company. Product and hiring updates only; no governance items.",
      label: "founder-catchup",
      note: '"sync" with a portfolio founder is a catch-up',
    },
    {
      title: "Investment committee",
      snippet: "Internal decision-making forum. Partners only. Voted on two new investments.",
      label: "internal",
      note: "IC is internal, not a board call",
    },
    {
      title: "Board meeting prep call with founder",
      snippet:
        "One-to-one with the founder of Dhaba Cloud ahead of the formal board meeting. Walked through the numbers she plans to present. Not the board meeting itself.",
      label: "founder-catchup",
      note: "prep with a portfolio founder, not the board meeting",
    },
    {
      title: "Zephyrwick Analytics — annual general meeting",
      snippet:
        "Shareholder AGM with the full board and company counsel present. Resolutions on auditor appointment were passed.",
      label: "board-call",
      note: "AGM with board governance content",
    },
    {
      title: "Coffee with Dev Castellan",
      snippet:
        "Founder of Tiffinwallah Systems, in our portfolio since the seed round. Casual conversation about a competitor's raise and his hiring plans.",
      label: "founder-catchup",
      note: "casual framing, portfolio founder",
    },
    {
      title: "Diligence call — reference",
      snippet:
        "Spoke to a customer reference for a company we are evaluating. External participant, not a founder, not in the portfolio.",
      label: "external-other",
      note: "diligence reference call",
    },
    {
      title: "Board — internal pre-read",
      snippet:
        "Team read-through of the board materials before circulation. Internal attendees only.",
      label: "internal",
      note: 'again "board" in the title, internal content',
    },
    {
      title: "Quarterly review with Peacock Payroll",
      snippet:
        "Full board in attendance including the independent director; approved the quarterly accounts and a change to the option pool.",
      label: "board-call",
      note: '"review" framing, board governance content',
    },
  ];
  for (const t of traps) push(t.title, t.snippet, t.label, "distractor", t.note);

  return { items, gold };
}

/* ------------------------------------------------------------------ *
 * (c) signal vs noise against the stated watchlist
 * ------------------------------------------------------------------ */

function signalItems(rng: Rng): { items: P2Item[]; gold: P2Gold[] } {
  const items: P2Item[] = [];
  const gold: P2Gold[] = [];
  let n = 0;
  const push = (text: string, label: "signal" | "noise", trapType: TrapType, note: string) => {
    const itemId = `p2-c-${String(++n).padStart(3, "0")}`;
    items.push({ id: itemId, labelSet: "signal", text, trapType, note });
    gold.push({ id: itemId, labelSet: "signal", labels: { classification: label } });
  };

  const materialEvents = [
    (co: string) =>
      `Heads up — ${co} just lost their largest customer, roughly 18% of ARR. Founder confirmed on a call this morning.`,
    (co: string) =>
      `${co}'s VP Engineering resigned yesterday. Second senior departure this quarter.`,
    (co: string) =>
      `${co} is starting to raise a bridge. They have about five months of runway left.`,
    (co: string) =>
      `${co} had a 14-hour outage over the weekend; two enterprise accounts have asked for SLA credits.`,
    (co: string) =>
      `${co} signed their largest contract to date — mid-six-figures annual, three-year term.`,
    (co: string) =>
      `${co} is being approached about an acquisition by a strategic. Early, but the founder wants advice.`,
    (co: string) => `${co} missed their Q3 plan by 30% and has paused all hiring.`,
  ];
  for (let i = 0; i < 21; i++) {
    const co = WATCHLIST[i % WATCHLIST.length]!;
    push(
      materialEvents[i % materialEvents.length]!(co),
      "signal",
      "none",
      "material event, watchlist company",
    );
  }

  // 14 traps: near-miss names, and watchlist companies with immaterial mentions
  const nearMiss = [
    "Brightloom Analytics",
    "Banyan Leaf Ventures",
    "Monsoon Media Group",
    "Zephyr Wick Candles",
    "Quillstone Partners",
    "Kolam Interiors",
    "Brightloom Kirana Foundation",
  ];
  for (let i = 0; i < 7; i++) {
    const co = nearMiss[i % nearMiss.length]!;
    push(
      `${co} just announced a round and a big customer win — congratulations to that team.`,
      "noise",
      "distractor",
      "name collides with a watchlist company but is a different entity",
    );
  }
  const immaterial = [
    (co: string) =>
      `Someone from ${co} shared a blog post about hiring. Decent read, nothing actionable.`,
    (co: string) => `${co}'s office is moving one floor up in the same building next month.`,
    (co: string) => `Saw a ${co} sticker on a laptop at the conference today.`,
    (co: string) => `${co} posted a job ad for a junior designer.`,
    (co: string) => `${co}'s founder liked our last portfolio newsletter.`,
    (co: string) => `Reminder: ${co} swag order arrives Thursday.`,
    (co: string) => `${co} rescheduled their standup to 10am.`,
  ];
  for (let i = 0; i < 7; i++) {
    const co = WATCHLIST[(i + 2) % WATCHLIST.length]!;
    push(
      immaterial[i % immaterial.length]!(co),
      "noise",
      "distractor",
      "watchlist company, immaterial content",
    );
  }

  return { items, gold };
}

/* ------------------------------------------------------------------ *
 * (d) thesis fit
 * ------------------------------------------------------------------ */

function thesisItems(rng: Rng): { items: P2Item[]; gold: P2Gold[] } {
  const items: P2Item[] = [];
  const gold: P2Gold[] = [];
  let n = 0;
  const push = (text: string, label: string, trapType: TrapType, note: string) => {
    const itemId = `p2-d-${String(++n).padStart(3, "0")}`;
    items.push({ id: itemId, labelSet: "thesis", text, trapType, note });
    gold.push({ id: itemId, labelSet: "thesis", labels: { fit: label } });
  };

  const inThesis = [
    "Pune-based vertical SaaS for diagnostic-lab chains: scheduling, billing and NABL compliance in one product. Sells to 20-200 bed operators.",
    "Berlin developer-infrastructure company selling deterministic CI caching to mid-market engineering teams.",
    "Bengaluru vertical SaaS for auto-component manufacturers — shop-floor scheduling and quality tracking for mid-sized plants.",
    "Lisbon-based observability tooling aimed at mid-market SaaS engineering teams, self-serve then sales-assisted.",
    "Chennai B2B software for freight forwarders: documentation, customs filing and rate management for mid-market operators.",
    "Amsterdam developer platform for feature-flagging and progressive rollout, sold to 50-500 engineer organisations.",
  ];
  for (let i = 0; i < 6; i++)
    push(
      inThesis[i]!,
      "in-thesis",
      "none",
      "core thesis: B2B vertical SaaS / dev infra, India or Europe, mid-market",
    );

  const adjacent = [
    "San Francisco vertical SaaS for dental practices, mid-market, strong retention. US-only go-to-market.",
    "Gurugram B2B software selling exclusively to large enterprises and public-sector banks; 18-month sales cycles.",
    "Warsaw developer tooling company, but the buyer is individual developers on a prosumer subscription.",
    "Mumbai B2B marketplace for industrial spares — takes a transaction fee rather than licensing software.",
    "Helsinki vertical SaaS for shipping lines, mid-market, but the company is at Series C with 300 staff.",
    "Bengaluru services firm doing custom software builds for mid-market manufacturers; project-based revenue.",
  ];
  for (let i = 0; i < 6; i++)
    push(
      adjacent[i]!,
      "adjacent",
      "none",
      "adjacent: right shape, wrong geography / stage / model",
    );

  const anti = [
    "A consumer social app for sharing short cooking videos, monetised through creator tipping.",
    "A crypto exchange and custody product for retail investors in emerging markets.",
    "A hardware-first company manufacturing warehouse robots; software is bundled with the units.",
    "A consumer dating application with a subscription tier, launching in three metros.",
    "A tokenised real-estate platform letting retail buyers purchase fractional property NFTs.",
    "A wearable fitness tracker company; revenue is device sales with an optional companion app.",
  ];
  for (let i = 0; i < 6; i++) push(anti[i]!, "anti-thesis", "none", "explicitly excluded category");

  // 12 traps: sound like one category, belong in another
  const traps: { text: string; label: string; note: string }[] = [
    {
      text: "Bengaluru software company selling fleet-maintenance scheduling to mid-market logistics operators. Their customers run hardware; the product is pure SaaS.",
      label: "in-thesis",
      note: "hardware-adjacent language, but the company is software",
    },
    {
      text: "Pune company building firmware and custom silicon for industrial sensors, sold to mid-market plants in India.",
      label: "anti-thesis",
      note: "India + mid-market, but hardware-first",
    },
    {
      text: "London B2B software helping mid-market banks meet crypto-asset reporting obligations. The company holds no digital assets itself.",
      label: "in-thesis",
      note: 'the word "crypto" appears, but this is B2B regtech',
    },
    {
      text: "Hyderabad platform where consumers discover and book salon appointments; salons pay a monthly subscription.",
      label: "anti-thesis",
      note: "framed as B2B subscription, demand side is consumer social commerce",
    },
    {
      text: "Madrid vertical SaaS for veterinary clinic groups, mid-market, strong net retention.",
      label: "in-thesis",
      note: "plain in-thesis, no trap wording",
    },
    {
      text: "Bengaluru developer-infrastructure company whose only product is a self-custody crypto wallet SDK for app developers.",
      label: "anti-thesis",
      note: "dev infra framing, crypto substance",
    },
    {
      text: "Toronto vertical SaaS for independent pharmacies, mid-market, expanding into the UK next year.",
      label: "adjacent",
      note: "right shape, geography outside India/Europe today",
    },
    {
      text: "Kraków B2B software for mid-market insurers; the founding team previously built consumer social products.",
      label: "in-thesis",
      note: "founder background is consumer, the company is not",
    },
    {
      text: "Delhi company selling a mid-market SaaS product bundled with the ruggedised tablets its customers must buy from them.",
      label: "adjacent",
      note: "software plus mandatory hardware — genuinely between categories",
    },
    {
      text: "Rotterdam developer tooling for supply-chain integrations, sold to mid-market shippers across the EU.",
      label: "in-thesis",
      note: "plain in-thesis",
    },
    {
      text: "Mumbai social network for chartered accountants, free to join, monetised via recruiter ads.",
      label: "anti-thesis",
      note: "professional framing, consumer social model",
    },
    {
      text: "Stockholm vertical SaaS for mid-market construction firms, currently pre-revenue with a design partner.",
      label: "in-thesis",
      note: "very early but squarely in thesis",
    },
  ];
  for (const t of traps) push(t.text, t.label, "distractor", t.note);

  return { items, gold };
}

/* ------------------------------------------------------------------ */

export interface P2Fixtures {
  items: P2Item[];
  gold: P2Gold[];
  watchlist: string[];
  thesis: string;
}

export function generateP2(seed: number): P2Fixtures {
  const rng = new Rng(seed);
  const a = fundingItems(rng);
  const a2 = collisionItems(rng, a.items.length);
  const b = meetingItems(rng);
  const c = signalItems(rng);
  const d = thesisItems(rng);

  return {
    items: [...a.items, ...a2.items, ...b.items, ...c.items, ...d.items],
    gold: [...a.gold, ...a2.gold, ...b.gold, ...c.gold, ...d.gold],
    watchlist: WATCHLIST,
    thesis: THESIS,
  };
}

/** Fails generation rather than shipping fixtures that quietly lost coverage. */
export function assertP2Invariants(f: P2Fixtures): void {
  const errs: string[] = [];

  if (f.items.length !== f.gold.length) errs.push("items/gold length mismatch");

  const ids = new Set(f.items.map((i) => i.id));
  if (ids.size !== f.items.length) errs.push("duplicate item ids");

  const goldById = new Map(f.gold.map((g) => [g.id, g]));
  for (const item of f.items) {
    if (!goldById.has(item.id)) errs.push(`${item.id}: no gold`);
  }

  const counts: Record<string, number> = {};
  for (const i of f.items) counts[i.labelSet] = (counts[i.labelSet] ?? 0) + 1;

  const traps: Record<string, number> = {};
  for (const i of f.items) traps[i.trapType] = (traps[i.trapType] ?? 0) + 1;
  for (const required of ["none", "distractor", "unit-trap", "spelled-number", "absent"]) {
    if ((traps[required] ?? 0) < 5) {
      errs.push(`trap coverage too thin: ${required}=${traps[required] ?? 0}, want >= 5`);
    }
  }

  // Funding: a stage may only be asserted on an actual event.
  for (const g of f.gold) {
    if (g.labelSet !== "funding") continue;
    if (g.labels.is_funding_event === false && g.labels.round_stage !== null) {
      errs.push(`${g.id}: non-event carries a round_stage`);
    }
  }

  // Meeting/thesis/signal labels must be inside their enums.
  const enums: Record<string, { key: string; allowed: string[] }> = {
    meeting: { key: "meeting_type", allowed: [...MEETING_CLASSES] },
    signal: { key: "classification", allowed: ["signal", "noise"] },
    thesis: { key: "fit", allowed: ["in-thesis", "adjacent", "anti-thesis"] },
  };
  for (const g of f.gold) {
    const spec = enums[g.labelSet];
    if (!spec) continue;
    const v = g.labels[spec.key];
    if (typeof v !== "string" || !spec.allowed.includes(v)) {
      errs.push(`${g.id}: ${spec.key}=${String(v)} not in [${spec.allowed.join(", ")}]`);
    }
  }

  // India traps must actually be present — they are mandatory for this suite.
  const inrForNonIndia = f.items.filter(
    (i) =>
      i.trapType === "unit-trap" &&
      i.text.includes("crore") &&
      !i.text.match(/Bengaluru|Pune|Hyderabad|Gurugram|Chennai|Indore/),
  );
  if (inrForNonIndia.length < 3) {
    errs.push(`need >= 3 INR-amount/non-India items, found ${inrForNonIndia.length}`);
  }
  if (f.items.filter((i) => i.trapType === "spelled-number").length < 5) {
    errs.push("need >= 5 spelled-number items");
  }

  if (errs.length > 0) {
    throw new Error(`P2 fixture invariants failed:\n  ${errs.join("\n  ")}`);
  }
}
