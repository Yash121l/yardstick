import { GLOBAL_COMPANIES, INDIA_CITIES, INDIA_COMPANIES, INVESTORS } from "./entities.js";
import { Rng } from "./rng.js";

/**
 * A synthetic portfolio warehouse. Ten tables, ~2k rows, all fictional.
 *
 * The schema deliberately mirrors the shape of a real portfolio warehouse
 * (companies / funds / rounds / normalised metrics / valuations / meeting docs)
 * so the NL->SQL questions require the same joins a real question would.
 */

export const SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS main;

CREATE TABLE main.funds (
  fund_id INTEGER PRIMARY KEY,
  name VARCHAR NOT NULL,
  vintage_year INTEGER NOT NULL,
  committed_usd BIGINT NOT NULL
);

CREATE TABLE main.companies (
  company_id INTEGER PRIMARY KEY,
  name VARCHAR NOT NULL,
  country VARCHAR NOT NULL,
  city VARCHAR NOT NULL,
  sector VARCHAR NOT NULL,
  founded_year INTEGER NOT NULL,
  status VARCHAR NOT NULL,          -- active | exited | written-off
  is_reported BOOLEAN NOT NULL
);

CREATE TABLE main.investments (
  investment_id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  fund_id INTEGER NOT NULL,
  first_invested_on DATE NOT NULL,
  ownership_pct DOUBLE NOT NULL
);

CREATE TABLE main.funding_rounds (
  round_id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  stage VARCHAR NOT NULL,
  announced_on DATE NOT NULL,
  amount_usd BIGINT NOT NULL,
  lead_investor VARCHAR
);

CREATE TABLE main.metrics_normalized (
  metric_id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  as_of DATE NOT NULL,
  metric VARCHAR NOT NULL,          -- arr_usd | burn_usd_month | runway_months | headcount | nrr_pct
  value DOUBLE NOT NULL
);

CREATE TABLE main.valuations (
  valuation_id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  as_of DATE NOT NULL,
  post_money_usd BIGINT NOT NULL,
  source VARCHAR NOT NULL           -- round | mark | secondary
);

CREATE TABLE main.people (
  person_id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  full_name VARCHAR NOT NULL,
  role VARCHAR NOT NULL,
  is_founder BOOLEAN NOT NULL,
  departed_on DATE
);

CREATE TABLE main.meeting_docs (
  doc_id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  met_on DATE NOT NULL,
  doc_type VARCHAR NOT NULL,        -- board | catchup | diligence
  quarter VARCHAR NOT NULL,
  raw_text VARCHAR NOT NULL
);

CREATE TABLE main.sectors (
  sector VARCHAR PRIMARY KEY,
  thesis_fit VARCHAR NOT NULL       -- core | adjacent | out
);

CREATE TABLE main.exits (
  exit_id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  exited_on DATE NOT NULL,
  proceeds_usd BIGINT NOT NULL,
  exit_type VARCHAR NOT NULL        -- acquisition | secondary | shutdown
);
`;

/** Given to the model in-prompt. Demands fully-qualified table names. */
export const SCHEMA_CARD = `
You are querying a DuckDB database. Always write fully-qualified table names in
the form warehouse.main.<table>. Queries that use bare table names will fail.

warehouse.main.funds(fund_id, name, vintage_year, committed_usd)
warehouse.main.companies(company_id, name, country, city, sector, founded_year, status, is_reported)
    status is one of 'active', 'exited', 'written-off'
warehouse.main.investments(investment_id, company_id, fund_id, first_invested_on, ownership_pct)
warehouse.main.funding_rounds(round_id, company_id, stage, announced_on, amount_usd, lead_investor)
    stage is one of 'pre-seed', 'seed', 'series-a', 'series-b', 'series-c'
warehouse.main.metrics_normalized(metric_id, company_id, as_of, metric, value)
    metric is one of 'arr_usd', 'burn_usd_month', 'runway_months', 'headcount', 'nrr_pct'
warehouse.main.valuations(valuation_id, company_id, as_of, post_money_usd, source)
warehouse.main.people(person_id, company_id, full_name, role, is_founder, departed_on)
    departed_on is NULL for people who are still there
warehouse.main.meeting_docs(doc_id, company_id, met_on, doc_type, quarter, raw_text)
    doc_type is one of 'board', 'catchup', 'diligence'; quarter looks like 'Q1'
warehouse.main.sectors(sector, thesis_fit)
    thesis_fit is one of 'core', 'adjacent', 'out'
warehouse.main.exits(exit_id, company_id, exited_on, proceeds_usd, exit_type)

Notes on this DuckDB instance:
- Today's date for the purposes of any question is 2026-08-02.
- For case-insensitive substring or pattern matching on text, use
  regexp_matches(lower(column), 'pattern'). Note that SIMILAR TO in DuckDB must
  match the WHOLE string and does not treat '.' as a wildcard.
`.trim();

export interface P3Question {
  id: string;
  question: string;
  goldSql: string;
  /** True when the correct answer is genuinely zero rows. */
  expectEmpty: boolean;
  /** Tagged so the report can break results down by trap. */
  trap: "none" | "dialect-trap" | "absent";
  note: string;
}

const METRICS = ["arr_usd", "burn_usd_month", "runway_months", "headcount", "nrr_pct"] as const;
const STAGES = ["pre-seed", "seed", "series-a", "series-b", "series-c"] as const;

function d(y: number, m: number, day: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export interface P3Data {
  inserts: string[];
  companyCount: number;
  rowCount: number;
}

export function generateData(seed: number): P3Data {
  const rng = new Rng(seed);
  const inserts: string[] = [];
  let rows = 0;
  const add = (sql: string) => {
    inserts.push(sql);
    rows++;
  };

  // --- sectors -----------------------------------------------------------
  const sectors = [
    ["quick-commerce", "adjacent"],
    ["fintech", "core"],
    ["devtools", "core"],
    ["logistics", "adjacent"],
    ["healthtech", "core"],
    ["hardware", "out"],
    ["saas", "core"],
    ["agritech", "adjacent"],
    ["security", "core"],
    ["infra", "core"],
    ["hr-tech", "core"],
    ["data", "core"],
    ["ai", "core"],
    ["biotech", "out"],
    ["climate", "adjacent"],
    ["manufacturing", "out"],
    ["retail", "adjacent"],
  ];
  for (const [s, fit] of sectors)
    add(`INSERT INTO main.sectors VALUES (${sqlStr(s!)}, ${sqlStr(fit!)});`);

  // --- funds -------------------------------------------------------------
  const funds = [
    [1, "Yardstick Fund I", 2018, 80_000_000],
    [2, "Yardstick Fund II", 2021, 160_000_000],
    [3, "Yardstick Opportunities", 2023, 90_000_000],
  ];
  for (const [id, name, vintage, committed] of funds) {
    add(
      `INSERT INTO main.funds VALUES (${id}, ${sqlStr(String(name))}, ${vintage}, ${committed});`,
    );
  }

  // --- companies ---------------------------------------------------------
  const pool = [...INDIA_COMPANIES, ...GLOBAL_COMPANIES];
  const companies: { id: number; name: string; india: boolean; sector: string; status: string }[] =
    [];
  for (let i = 0; i < 60; i++) {
    const base = pool[i % pool.length]!;
    const suffix =
      i < pool.length
        ? ""
        : ` ${["Labs", "Systems", "Group", "Technologies"][Math.floor(i / pool.length) - 1] ?? "Holdings"}`;
    const name = `${base.name}${suffix}`;
    const india = base.india;
    const status = i % 11 === 0 ? "exited" : i % 17 === 0 ? "written-off" : "active";
    const id = i + 1;
    companies.push({ id, name, india, sector: base.sector, status });
    add(
      `INSERT INTO main.companies VALUES (${id}, ${sqlStr(name)}, ${sqlStr(india ? "India" : "Other")}, ` +
        `${sqlStr(india ? INDIA_CITIES[i % INDIA_CITIES.length]! : "Lisbon")}, ${sqlStr(base.sector)}, ` +
        `${2014 + (i % 10)}, ${sqlStr(status)}, ${i % 7 === 0 ? "false" : "true"});`,
    );
  }

  // --- investments -------------------------------------------------------
  let invId = 0;
  for (const c of companies) {
    const fundId = (c.id % 3) + 1;
    add(
      `INSERT INTO main.investments VALUES (${++invId}, ${c.id}, ${fundId}, ` +
        `DATE ${sqlStr(d(2019 + (c.id % 6), 1 + (c.id % 12), 1 + (c.id % 27)))}, ${(5 + (c.id % 20) + rng.int(0, 9) / 10).toFixed(2)});`,
    );
  }

  // --- funding rounds ----------------------------------------------------
  let roundId = 0;
  for (const c of companies) {
    const n = 1 + (c.id % 3);
    for (let r = 0; r < n; r++) {
      const stage = STAGES[Math.min(r + (c.id % 2), STAGES.length - 1)]!;
      add(
        `INSERT INTO main.funding_rounds VALUES (${++roundId}, ${c.id}, ${sqlStr(stage)}, ` +
          `DATE ${sqlStr(d(2020 + r + (c.id % 4), 1 + ((c.id + r) % 12), 1 + ((c.id + r) % 27)))}, ` +
          `${(1_000_000 + rng.int(1, 40) * 500_000).toFixed(0)}, ${sqlStr(INVESTORS[(c.id + r) % INVESTORS.length]!)});`,
      );
    }
  }

  // --- metrics -----------------------------------------------------------
  let metricId = 0;
  for (const c of companies) {
    for (const metric of METRICS) {
      // Two observations each, so questions must pick the latest.
      for (const [idx, asOf] of [d(2026, 3, 31), d(2026, 6, 30)].entries()) {
        let value: number;
        switch (metric) {
          case "arr_usd":
            value = 200_000 + c.id * 55_000 + idx * 40_000;
            break;
          case "burn_usd_month":
            value = 20_000 + (c.id % 9) * 11_000 + idx * 1_500;
            break;
          case "runway_months":
            // A deliberate spread so "< 6 months" selects a small, stable set.
            value = 3 + ((c.id * 7) % 28);
            break;
          case "headcount":
            value = 8 + ((c.id * 3) % 90) + idx;
            break;
          default:
            value = 85 + ((c.id * 5) % 45);
        }
        add(
          `INSERT INTO main.metrics_normalized VALUES (${++metricId}, ${c.id}, DATE ${sqlStr(asOf)}, ${sqlStr(metric)}, ${value});`,
        );
      }
    }
  }

  // --- valuations --------------------------------------------------------
  let valId = 0;
  for (const c of companies) {
    add(
      `INSERT INTO main.valuations VALUES (${++valId}, ${c.id}, DATE ${sqlStr(d(2026, 6, 30))}, ` +
        `${(8_000_000 + c.id * 2_400_000).toFixed(0)}, ${sqlStr(["round", "mark", "secondary"][c.id % 3]!)});`,
    );
  }

  // --- people ------------------------------------------------------------
  let personId = 0;
  const firstNames = [
    "Anaya",
    "Dev",
    "Rhea",
    "Kabir",
    "Meera",
    "Arjun",
    "Nina",
    "Vikram",
    "Priya",
    "Tobias",
  ];
  const lastNames = [
    "Vermillion",
    "Castellan",
    "Underhill",
    "Ashgrove",
    "Thistlewood",
    "Pellworth",
    "Farrowgate",
    "Ollandry",
    "Sandhurst",
    "Rennick",
  ];
  for (const c of companies) {
    for (let p = 0; p < 2; p++) {
      const departed =
        (c.id + p) % 9 === 0 ? `DATE ${sqlStr(d(2026, 1 + ((c.id + p) % 6), 15))}` : "NULL";
      add(
        `INSERT INTO main.people VALUES (${++personId}, ${c.id}, ` +
          `${sqlStr(`${firstNames[(c.id + p) % firstNames.length]} ${lastNames[(c.id + p * 3) % lastNames.length]}`)}, ` +
          `${sqlStr(p === 0 ? "CEO" : "CTO")}, ${p === 0 ? "true" : "false"}, ${departed});`,
      );
    }
  }

  // --- meeting docs ------------------------------------------------------
  // Text is seeded with specific keywords so the regexp question has a stable
  // gold answer. "runway" and "cash out" appear only where intended.
  let docId = 0;
  for (const c of companies) {
    const n = 1 + (c.id % 3);
    for (let m = 0; m < n; m++) {
      const quarter = `Q${1 + ((c.id + m) % 4)}`;
      const mentionsRunway = c.id % 5 === 0 && quarter === "Q1";
      const mentionsCashOut = c.id % 8 === 0 && quarter === "Q1";
      const body = [
        "Reviewed the operating plan and the hiring pipeline.",
        mentionsRunway ? "The team flagged that runway is tighter than planned." : "",
        mentionsCashOut ? "Discussed the date the company would cash out without a bridge." : "",
        "Agreed to revisit pricing at the next session.",
      ]
        .filter(Boolean)
        .join(" ");
      add(
        `INSERT INTO main.meeting_docs VALUES (${++docId}, ${c.id}, ` +
          `DATE ${sqlStr(d(2026, 1 + ((c.id + m) % 7), 5 + ((c.id + m) % 20)))}, ` +
          `${sqlStr(["board", "catchup", "diligence"][(c.id + m) % 3]!)}, ${sqlStr(quarter)}, ${sqlStr(body)});`,
      );
    }
  }

  // --- exits -------------------------------------------------------------
  let exitId = 0;
  for (const c of companies.filter((x) => x.status === "exited")) {
    add(
      `INSERT INTO main.exits VALUES (${++exitId}, ${c.id}, DATE ${sqlStr(d(2025, 1 + (c.id % 12), 10))}, ` +
        `${(15_000_000 + c.id * 3_100_000).toFixed(0)}, ${sqlStr(["acquisition", "secondary"][c.id % 2]!)});`,
    );
  }

  return { inserts, companyCount: companies.length, rowCount: rows };
}

const LATEST = "2026-06-30";

/**
 * 30 questions. Five have a genuinely empty answer; one is the SIMILAR TO
 * dialect trap. Gold SQL is executed at generation time — a question whose gold
 * query errors, or whose empty/non-empty shape is wrong, fails generation.
 */
export const QUESTIONS: P3Question[] = [
  {
    id: "p3-001",
    question: "How many companies are in the portfolio?",
    goldSql: "SELECT count(*) AS n FROM warehouse.main.companies",
    expectEmpty: false,
    trap: "none",
    note: "trivial count",
  },
  {
    id: "p3-002",
    question: "List the names of all companies headquartered in India, ordered alphabetically.",
    goldSql: "SELECT name FROM warehouse.main.companies WHERE country = 'India' ORDER BY name",
    expectEmpty: false,
    trap: "none",
    note: "ordering is demanded, so the grader enforces it",
  },
  {
    id: "p3-003",
    question: "Which companies have fewer than 6 months of runway as of the latest reading?",
    goldSql: `SELECT c.name FROM warehouse.main.companies c JOIN warehouse.main.metrics_normalized m ON m.company_id = c.company_id WHERE m.metric = 'runway_months' AND m.as_of = DATE '${LATEST}' AND m.value < 6`,
    expectEmpty: false,
    trap: "none",
    note: "latest-reading filter plus threshold",
  },
  {
    id: "p3-004",
    question:
      "Which companies have fewer than 6 months of runway at the latest reading AND have had no meeting of any kind in the last 60 days?",
    goldSql: `SELECT c.name FROM warehouse.main.companies c JOIN warehouse.main.metrics_normalized m ON m.company_id = c.company_id WHERE m.metric = 'runway_months' AND m.as_of = DATE '${LATEST}' AND m.value < 6 AND NOT EXISTS (SELECT 1 FROM warehouse.main.meeting_docs d WHERE d.company_id = c.company_id AND d.met_on >= DATE '2026-06-03')`,
    expectEmpty: false,
    trap: "none",
    note: "the flagship question: threshold plus a NOT EXISTS recency check",
  },
  {
    id: "p3-005",
    question: "What is the total committed capital across all funds, in USD?",
    goldSql: "SELECT sum(committed_usd) AS total FROM warehouse.main.funds",
    expectEmpty: false,
    trap: "none",
    note: "aggregate",
  },
  {
    id: "p3-006",
    question: "For each fund, how many companies has it invested in?",
    goldSql:
      "SELECT f.name, count(DISTINCT i.company_id) AS n FROM warehouse.main.funds f JOIN warehouse.main.investments i ON i.fund_id = f.fund_id GROUP BY f.name",
    expectEmpty: false,
    trap: "none",
    note: "group-by with a distinct count",
  },
  {
    id: "p3-007",
    question: "Which companies raised a series-b round during 2023?",
    goldSql:
      "SELECT DISTINCT c.name FROM warehouse.main.companies c JOIN warehouse.main.funding_rounds r ON r.company_id = c.company_id WHERE r.stage = 'series-b' AND r.announced_on >= DATE '2023-01-01' AND r.announced_on < DATE '2024-01-01'",
    expectEmpty: false,
    trap: "none",
    note: "date-range filter",
  },
  {
    id: "p3-008",
    question:
      "Which companies have a board-meeting document from Q1 whose text matches the pattern 'runway|cash out', case-insensitively?",
    goldSql:
      "SELECT DISTINCT c.name FROM warehouse.main.companies c JOIN warehouse.main.meeting_docs d ON d.company_id = c.company_id WHERE d.quarter = 'Q1' AND d.doc_type = 'board' AND regexp_matches(lower(d.raw_text), 'runway|cash out')",
    expectEmpty: false,
    trap: "dialect-trap",
    note: "SIMILAR TO '.*(runway|cash out).*' silently returns zero rows in DuckDB",
  },
  {
    id: "p3-009",
    question: "What is the latest ARR for each company in the fintech sector?",
    goldSql: `SELECT c.name, m.value AS arr_usd FROM warehouse.main.companies c JOIN warehouse.main.metrics_normalized m ON m.company_id = c.company_id WHERE c.sector = 'fintech' AND m.metric = 'arr_usd' AND m.as_of = DATE '${LATEST}'`,
    expectEmpty: false,
    trap: "none",
    note: "sector filter plus latest metric",
  },
  {
    id: "p3-010",
    question:
      "Which five companies have the highest latest ARR? Return name and ARR, highest first.",
    goldSql: `SELECT c.name, m.value AS arr_usd FROM warehouse.main.companies c JOIN warehouse.main.metrics_normalized m ON m.company_id = c.company_id WHERE m.metric = 'arr_usd' AND m.as_of = DATE '${LATEST}' ORDER BY m.value DESC LIMIT 5`,
    expectEmpty: false,
    trap: "none",
    note: "top-N with explicit ordering",
  },
  {
    id: "p3-011",
    question: "How many companies are in each thesis-fit category?",
    goldSql:
      "SELECT s.thesis_fit, count(*) AS n FROM warehouse.main.companies c JOIN warehouse.main.sectors s ON s.sector = c.sector GROUP BY s.thesis_fit",
    expectEmpty: false,
    trap: "none",
    note: "join to the sector lookup",
  },
  {
    id: "p3-012",
    question: "Which companies have had a founder depart?",
    goldSql:
      "SELECT DISTINCT c.name FROM warehouse.main.companies c JOIN warehouse.main.people p ON p.company_id = c.company_id WHERE p.is_founder AND p.departed_on IS NOT NULL",
    expectEmpty: false,
    trap: "none",
    note: "NULL semantics on departed_on",
  },
  {
    id: "p3-013",
    question: "What is the average ownership percentage held by Yardstick Fund II?",
    goldSql:
      "SELECT avg(i.ownership_pct) AS avg_pct FROM warehouse.main.investments i JOIN warehouse.main.funds f ON f.fund_id = i.fund_id WHERE f.name = 'Yardstick Fund II'",
    expectEmpty: false,
    trap: "none",
    note: "average with a join filter",
  },
  {
    id: "p3-014",
    question: "Which companies are marked as written-off?",
    goldSql: "SELECT name FROM warehouse.main.companies WHERE status = 'written-off'",
    expectEmpty: false,
    trap: "none",
    note: "status filter",
  },
  {
    id: "p3-015",
    question: "What were the total exit proceeds in 2025?",
    goldSql:
      "SELECT sum(proceeds_usd) AS total FROM warehouse.main.exits WHERE exited_on >= DATE '2025-01-01' AND exited_on < DATE '2026-01-01'",
    expectEmpty: false,
    trap: "none",
    note: "aggregate over a date range",
  },
  {
    id: "p3-016",
    question: "Which companies have a latest net revenue retention below 90%?",
    goldSql: `SELECT c.name FROM warehouse.main.companies c JOIN warehouse.main.metrics_normalized m ON m.company_id = c.company_id WHERE m.metric = 'nrr_pct' AND m.as_of = DATE '${LATEST}' AND m.value < 90`,
    expectEmpty: false,
    trap: "none",
    note: "threshold on a percentage metric",
  },
  {
    id: "p3-017",
    question: "How many funding rounds were led by Thornfield Partners?",
    goldSql:
      "SELECT count(*) AS n FROM warehouse.main.funding_rounds WHERE lead_investor = 'Thornfield Partners'",
    expectEmpty: false,
    trap: "none",
    note: "exact string filter",
  },
  {
    id: "p3-018",
    question:
      "Which companies in a 'core' thesis-fit sector have more than 50 headcount at the latest reading?",
    goldSql: `SELECT c.name FROM warehouse.main.companies c JOIN warehouse.main.sectors s ON s.sector = c.sector JOIN warehouse.main.metrics_normalized m ON m.company_id = c.company_id WHERE s.thesis_fit = 'core' AND m.metric = 'headcount' AND m.as_of = DATE '${LATEST}' AND m.value > 50`,
    expectEmpty: false,
    trap: "none",
    note: "three-table join",
  },
  {
    id: "p3-019",
    question: "What is the latest post-money valuation for each exited company?",
    goldSql:
      "SELECT c.name, v.post_money_usd FROM warehouse.main.companies c JOIN warehouse.main.valuations v ON v.company_id = c.company_id WHERE c.status = 'exited'",
    expectEmpty: false,
    trap: "none",
    note: "join plus status filter",
  },
  {
    id: "p3-020",
    question: "How many meeting documents of each type are there?",
    goldSql: "SELECT doc_type, count(*) AS n FROM warehouse.main.meeting_docs GROUP BY doc_type",
    expectEmpty: false,
    trap: "none",
    note: "simple group-by",
  },
  {
    id: "p3-021",
    question: "Which companies are not reported in the portfolio pack?",
    goldSql: "SELECT name FROM warehouse.main.companies WHERE is_reported = false",
    expectEmpty: false,
    trap: "none",
    note: "boolean filter",
  },
  {
    id: "p3-022",
    question: "Which companies raised more than $25 million in a single round?",
    goldSql:
      "SELECT DISTINCT c.name FROM warehouse.main.companies c JOIN warehouse.main.funding_rounds r ON r.company_id = c.company_id WHERE r.amount_usd > 25000000",
    expectEmpty: true,
    trap: "absent",
    note: "the largest round in the warehouse is about $21m — correct answer is no rows",
  },
  {
    id: "p3-023",
    question: "Which companies were founded before 2010?",
    goldSql: "SELECT name FROM warehouse.main.companies WHERE founded_year < 2010",
    expectEmpty: true,
    trap: "absent",
    note: "the earliest founding year is 2014 — correct answer is no rows",
  },
  {
    id: "p3-024",
    question: "Which companies have a latest runway of more than 60 months?",
    goldSql: `SELECT c.name FROM warehouse.main.companies c JOIN warehouse.main.metrics_normalized m ON m.company_id = c.company_id WHERE m.metric = 'runway_months' AND m.as_of = DATE '${LATEST}' AND m.value > 60`,
    expectEmpty: true,
    trap: "absent",
    note: "runway tops out around 30 months — correct answer is no rows",
  },
  {
    id: "p3-025",
    question: "Which companies exited via a shutdown?",
    goldSql:
      "SELECT c.name FROM warehouse.main.companies c JOIN warehouse.main.exits e ON e.company_id = c.company_id WHERE e.exit_type = 'shutdown'",
    expectEmpty: true,
    trap: "absent",
    note: "no shutdown exits exist — correct answer is no rows",
  },
  {
    id: "p3-026",
    question: "Which funds have a vintage year before 2015?",
    goldSql: "SELECT name FROM warehouse.main.funds WHERE vintage_year < 2015",
    expectEmpty: true,
    trap: "absent",
    note: "earliest vintage is 2018 — correct answer is no rows",
  },
  {
    id: "p3-027",
    question: "Which companies in the 'biotech' sector are active?",
    goldSql:
      "SELECT name FROM warehouse.main.companies WHERE sector = 'biotech' AND status = 'active'",
    expectEmpty: false,
    trap: "none",
    note: "sector plus status",
  },
  {
    id: "p3-028",
    question: "What is the median latest ARR across all companies?",
    goldSql: `SELECT median(m.value) AS median_arr FROM warehouse.main.metrics_normalized m WHERE m.metric = 'arr_usd' AND m.as_of = DATE '${LATEST}'`,
    expectEmpty: false,
    trap: "none",
    note: "DuckDB median()",
  },
  {
    id: "p3-029",
    question:
      "For each company, how many funding rounds has it raised? Return only companies with at least three rounds.",
    goldSql:
      "SELECT c.name, count(*) AS n FROM warehouse.main.companies c JOIN warehouse.main.funding_rounds r ON r.company_id = c.company_id GROUP BY c.name HAVING count(*) >= 3",
    expectEmpty: false,
    trap: "none",
    note: "GROUP BY with HAVING",
  },
  {
    id: "p3-030",
    question:
      "Which companies had a meeting in Q1 and also have a latest burn above $80,000 a month?",
    goldSql: `SELECT DISTINCT c.name FROM warehouse.main.companies c JOIN warehouse.main.meeting_docs d ON d.company_id = c.company_id JOIN warehouse.main.metrics_normalized m ON m.company_id = c.company_id WHERE d.quarter = 'Q1' AND m.metric = 'burn_usd_month' AND m.as_of = DATE '${LATEST}' AND m.value > 80000`,
    expectEmpty: false,
    trap: "none",
    note: "two joins plus a threshold",
  },
];
