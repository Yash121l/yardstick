/**
 * Fixture entities. Every name here is invented and is meant to read as
 * invented — no real company, founder, fund, or portfolio data appears
 * anywhere in this repo, so any fixture is safe to send to any third party.
 */

export interface Company {
  name: string;
  /** Drives the is_india gold label. Never inferred from currency in the text. */
  india: boolean;
  sector: string;
  oneLiner: string;
}

/** India-headquartered fictional companies. */
export const INDIA_COMPANIES: Company[] = [
  {
    name: "Brightloom Kirana",
    india: true,
    sector: "quick-commerce",
    oneLiner: "10-minute grocery delivery for tier-2 cities",
  },
  {
    name: "Tiffinwallah Systems",
    india: true,
    sector: "logistics",
    oneLiner: "route optimisation for last-mile meal delivery fleets",
  },
  {
    name: "Banyan Ledger",
    india: true,
    sector: "fintech",
    oneLiner: "reconciliation software for small NBFCs",
  },
  {
    name: "Monsoon Metrics",
    india: true,
    sector: "devtools",
    oneLiner: "observability tuned for low-bandwidth deployments",
  },
  {
    name: "Peacock Payroll",
    india: true,
    sector: "hr-tech",
    oneLiner: "payroll and compliance for firms under 200 staff",
  },
  {
    name: "Rickshaw Robotics",
    india: true,
    sector: "hardware",
    oneLiner: "retrofit autonomy kits for three-wheeled cargo vehicles",
  },
  {
    name: "Kolam Health",
    india: true,
    sector: "healthtech",
    oneLiner: "teleconsult scheduling for multi-clinic chains",
  },
  {
    name: "Dhaba Cloud",
    india: true,
    sector: "saas",
    oneLiner: "point-of-sale and inventory for roadside restaurant chains",
  },
  {
    name: "Sitaphal Labs",
    india: true,
    sector: "agritech",
    oneLiner: "cold-chain monitoring for fruit exporters",
  },
  {
    name: "Ghatak Security",
    india: true,
    sector: "security",
    oneLiner: "runtime threat detection for containerised workloads",
  },
  {
    name: "Chandni Credit",
    india: true,
    sector: "fintech",
    oneLiner: "underwriting for informal-sector borrowers",
  },
  {
    name: "Nilgiri Networks",
    india: true,
    sector: "infra",
    oneLiner: "edge caching for regional streaming platforms",
  },
];

/** Non-India fictional companies. Some deliberately transact in INR. */
export const GLOBAL_COMPANIES: Company[] = [
  {
    name: "Zephyrwick Analytics",
    india: false,
    sector: "data",
    oneLiner: "warehouse-native product analytics",
  },
  {
    name: "Quillstone Systems",
    india: false,
    sector: "devtools",
    oneLiner: "deterministic build caching for monorepos",
  },
  {
    name: "Tanglefoot AI",
    india: false,
    sector: "ai",
    oneLiner: "evaluation tooling for retrieval pipelines",
  },
  {
    name: "Harrowgate Freight",
    india: false,
    sector: "logistics",
    oneLiner: "freight brokerage marketplace for mid-size shippers",
  },
  {
    name: "Pellucid Bio",
    india: false,
    sector: "biotech",
    oneLiner: "assay automation for contract research labs",
  },
  {
    name: "Marrowbone Capital Tech",
    india: false,
    sector: "fintech",
    oneLiner: "portfolio accounting for private credit funds",
  },
  {
    name: "Fenwick Loom",
    india: false,
    sector: "manufacturing",
    oneLiner: "scheduling software for textile plants",
  },
  {
    name: "Alderbrook Grid",
    india: false,
    sector: "climate",
    oneLiner: "demand forecasting for distribution utilities",
  },
  {
    name: "Ptarmigan Health",
    india: false,
    sector: "healthtech",
    oneLiner: "prior-authorisation automation for specialty clinics",
  },
  {
    name: "Vellichor Retail",
    india: false,
    sector: "retail",
    oneLiner: "shelf-level demand planning for grocery chains",
  },
];

/**
 * Near-identical name pairs. The distractor is a DIFFERENT company that shares
 * a stem with the subject — this is the Indian entity-name collision trap.
 */
export const COLLISION_PAIRS: { subject: string; collider: string; india: boolean }[] = [
  { subject: "Brightloom Kirana", collider: "Brightloom Analytics", india: true },
  { subject: "Kirana Kart", collider: "Kirana Cart Technologies", india: true },
  { subject: "Banyan Ledger", collider: "Banyan Leaf Ventures", india: true },
  { subject: "Monsoon Metrics", collider: "Monsoon Media Group", india: true },
  { subject: "Peacock Payroll", collider: "Peacock Provisions", india: true },
  { subject: "Zephyrwick Analytics", collider: "Zephyr Wick Candles", india: false },
  { subject: "Quillstone Systems", collider: "Quillstone Partners", india: false },
];

export const INVESTORS = [
  "Thornfield Partners",
  "Alcott Ridge Capital",
  "Sable & Pike",
  "Greyloft Ventures",
  "Dovetail Growth",
  "Marchmont Fund II",
  "Pallavi Bridge Capital",
  "Oakmoss Seed",
];

export const FOUNDERS = [
  "Anaya Vermillion",
  "Dev Castellan",
  "Rhea Underhill",
  "Kabir Ashgrove",
  "Meera Thistlewood",
  "Arjun Pellworth",
  "Nina Farrowgate",
  "Vikram Ollandry",
  "Priya Sandhurst",
  "Tobias Rennick",
];

export const INDIA_CITIES = ["Bengaluru", "Pune", "Hyderabad", "Gurugram", "Chennai", "Indore"];
export const GLOBAL_CITIES = ["Lisbon", "Toronto", "Rotterdam", "Austin", "Helsinki", "Melbourne"];

export const ROUND_STAGES = ["pre-seed", "seed", "series-a", "series-b", "series-c"] as const;
export type RoundStage = (typeof ROUND_STAGES)[number];

/** Spelled-out Indian numbering, for the spelled-number trap. */
export const SPELLED_CRORE: Record<number, string> = {
  8: "eight crore",
  12: "twelve crore",
  18: "eighteen crore",
  25: "twenty-five crore",
  40: "forty crore",
  60: "sixty crore",
};

export const SPELLED_MILLION: Record<number, string> = {
  4: "four million",
  9: "nine million",
  15: "fifteen million",
  22: "twenty-two million",
  30: "thirty million",
};

export const ALL_COMPANIES: Company[] = [...INDIA_COMPANIES, ...GLOBAL_COMPANIES];
