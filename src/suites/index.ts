import { helloSuite } from "./hello.js";
import { p1Suite } from "./p1.js";
import { p2Suite } from "./p2.js";
import { p3Suite } from "./p3.js";
import { p4Suite } from "./p4.js";
import { p5Suite } from "./p5.js";
import { p6Suite } from "./p6.js";
import { p7Suite } from "./p7.js";
import type { Suite } from "./types.js";

/** Suites available to --suite. */
export const SUITES: Record<string, Suite> = {
  hello: helloSuite,
  p1: p1Suite,
  p2: p2Suite,
  p3: p3Suite,
  p4: p4Suite,
  p5: p5Suite,
  p6: p6Suite,
  p7: p7Suite,
};

/** What `--suite all` expands to. `hello` is a wiring check, not an eval. */
export const ALL_SUITE_IDS: string[] = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];

export function resolveSuites(arg: string): { suites: Suite[]; unknown: string[] } {
  const wanted =
    arg === "all"
      ? ALL_SUITE_IDS
      : arg
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
  const suites: Suite[] = [];
  const unknown: string[] = [];
  for (const id of wanted) {
    const s = SUITES[id];
    if (s) suites.push(s);
    else unknown.push(id);
  }
  return { suites, unknown };
}
