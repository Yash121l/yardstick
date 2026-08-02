import { Rng } from "./rng.js";

/**
 * A fixed ~10,000-word English corpus for the tokenizer-weight probe.
 *
 * Deterministic and frozen: the whole point is that the SAME text is billed by
 * every model, so the only thing that varies is the tokenizer. Real-ish prose
 * rather than word soup, because tokenizer ratios on random tokens do not
 * predict ratios on production traffic.
 */

const SUBJECTS = [
  "the operations team",
  "a regional distributor",
  "the platform",
  "our finance lead",
  "the migration",
  "the second cohort",
  "the pricing committee",
  "a mid-market customer",
  "the ingestion pipeline",
  "the quarterly review",
  "the support queue",
  "an internal audit",
];
const VERBS = [
  "recorded",
  "postponed",
  "renegotiated",
  "consolidated",
  "flagged",
  "absorbed",
  "escalated",
  "reconciled",
  "deprecated",
  "benchmarked",
  "provisioned",
  "unwound",
];
const OBJECTS = [
  "a material variance in the reported figures",
  "the renewal schedule for the coming period",
  "three separate reconciliation exceptions",
  "the backlog that had accumulated since the migration",
  "an unusually large batch of pending records",
  "the revised allocation across cost centres",
  "a dependency that had gone unmaintained for some months",
  "the threshold at which alerts are raised",
];
const CONNECTORS = [
  "As a result,",
  "In practice,",
  "By the end of the period,",
  "Notably,",
  "For the avoidance of doubt,",
  "Subsequently,",
  "On balance,",
  "In addition,",
];
const TAILS = [
  "which the team expects to resolve before the next review",
  "though the underlying cause remains under investigation",
  "and the figures have been restated accordingly",
  "with no material effect on the reported position",
  "pending confirmation from the counterparty",
  "although the timing may shift by a week or two",
];

const OPENERS = [
  "The report notes that",
  "It should be recorded that",
  "Management confirmed that",
  "The committee observed that",
  "Documentation indicates that",
  "The summary states that",
];
const SHORT_FACTS = [
  "No further action is required at this stage.",
  "The position is unchanged from the previous period.",
  "A follow-up has been scheduled.",
  "The relevant owner has been notified.",
  "This item remains open.",
  "The supporting documentation has been filed.",
  "Two approvals are still outstanding.",
  "The revised figure has been circulated.",
];
const QUESTIONS = [
  "What remains unclear is how the revised threshold interacts with the existing schedule.",
  "Whether this represents a timing difference or a genuine variance is still being established.",
  "How much of the backlog is recoverable within the period has not yet been determined.",
  "Why the earlier estimate diverged so sharply from the outturn is the subject of a separate note.",
];

/**
 * Six sentence shapes rather than one, drawn in a varied order.
 *
 * The first version of this used a single five-slot template repeated ~500
 * times. That is degenerate text, and at least one model's safety classifier
 * refused the whole prompt rather than reading it — which produced a tokenizer
 * measurement of three tokens. Varied structure both avoids that and makes the
 * ratio a better predictor of real traffic.
 */
export function generateCorpus(seed: number, targetWords = 10_000): string {
  const rng = new Rng(seed);
  const sentences: string[] = [];
  let words = 0;

  while (words < targetWords) {
    let s: string;
    switch (rng.int(0, 5)) {
      case 0:
        s = `${rng.pick(CONNECTORS)} ${rng.pick(SUBJECTS)} ${rng.pick(VERBS)} ${rng.pick(OBJECTS)}, ${rng.pick(TAILS)}.`;
        break;
      case 1:
        s = `${rng.pick(OPENERS)} ${rng.pick(SUBJECTS)} ${rng.pick(VERBS)} ${rng.pick(OBJECTS)}.`;
        break;
      case 2:
        s = `${rng.pick(SHORT_FACTS)}`;
        break;
      case 3:
        s = `${rng.pick(QUESTIONS)}`;
        break;
      case 4: {
        const a = rng.pick(SUBJECTS);
        const b = rng.pick(SUBJECTS);
        s = `Where ${a} and ${b} disagreed, ${rng.pick(TAILS)}; the matter was ${rng.pick(VERBS)} at the following meeting.`;
        break;
      }
      default: {
        const n = rng.int(2, 97);
        const pct = rng.int(1, 40);
        s = `In the ${n}th week, ${rng.pick(SUBJECTS)} ${rng.pick(VERBS)} ${rng.pick(OBJECTS)}, a movement of roughly ${pct} per cent against plan.`;
        break;
      }
    }
    sentences.push(s);
    words += s.split(/\s+/).length;
  }

  const paras: string[] = [];
  let i = 0;
  while (i < sentences.length) {
    const take = 4 + Math.floor((i * 7919) % 5); // 4-8 sentences, deterministic
    paras.push(sentences.slice(i, i + take).join(" "));
    i += take;
  }
  return paras.join("\n\n");
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).length;
}
