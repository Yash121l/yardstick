import { describe, expect, it } from "vitest";
import {
  type SqlResult,
  canonicalValue,
  checkStatement,
  demandsOrder,
  resultsEquivalent,
} from "./sql-exec.js";

const R = (columns: string[], rows: unknown[][]): SqlResult => ({ ok: true, columns, rows });

describe("checkStatement — read-only enforcement", () => {
  it("accepts a plain SELECT", () => {
    expect(checkStatement("SELECT 1").ok).toBe(true);
  });
  it("accepts a CTE", () => {
    expect(checkStatement("WITH x AS (SELECT 1) SELECT * FROM x").ok).toBe(true);
  });
  it("tolerates a trailing semicolon", () => {
    const c = checkStatement("SELECT 1;");
    expect(c.ok).toBe(true);
    expect(c.statement).toBe("SELECT 1");
  });
  it("rejects a bare DELETE", () => {
    expect(checkStatement("DELETE FROM t").kind).toBe("non-select");
  });
  it("rejects a DROP hidden behind a SELECT", () => {
    // A prefix-only check would wave this through.
    expect(checkStatement("SELECT 1; DROP TABLE t").kind).toBe("multiple-statements");
  });
  it("rejects an UPDATE inside a CTE", () => {
    expect(checkStatement("WITH x AS (SELECT 1) UPDATE t SET a = 1").kind).toBe("non-select");
  });
  it("rejects ATTACH", () => {
    expect(checkStatement("SELECT * FROM t WHERE a = 1 ATTACH 'x'").kind).toBe("non-select");
  });
  it("is not fooled by a forbidden keyword inside a string literal", () => {
    expect(checkStatement("SELECT 'drop table users' AS s").ok).toBe(true);
  });
  it("is not fooled by a forbidden keyword inside a comment", () => {
    expect(checkStatement("SELECT 1 -- drop table users").ok).toBe(true);
  });
  it("is not fooled by a semicolon inside a string literal", () => {
    expect(checkStatement("SELECT 'a;b' AS s").ok).toBe(true);
  });
  it("rejects empty input", () => {
    expect(checkStatement("   ").kind).toBe("empty");
  });
});

describe("demandsOrder", () => {
  it("detects ORDER BY", () => {
    expect(demandsOrder("SELECT a FROM t ORDER BY a")).toBe(true);
  });
  it("ignores the phrase inside a string", () => {
    expect(demandsOrder("SELECT 'order by' FROM t")).toBe(false);
  });
  it("is false for an unordered query", () => {
    expect(demandsOrder("SELECT a FROM t")).toBe(false);
  });
});

describe("canonicalValue", () => {
  it("treats a numeric string and a number alike", () => {
    expect(canonicalValue(5)).toBe(canonicalValue("5"));
  });
  it("treats BigInt and number alike", () => {
    expect(canonicalValue(10n)).toBe(canonicalValue(10));
  });
  it("distinguishes null from zero", () => {
    expect(canonicalValue(null)).not.toBe(canonicalValue(0));
  });
  it("tolerates float noise", () => {
    expect(canonicalValue(0.1 + 0.2)).toBe(canonicalValue(0.3));
  });
});

describe("resultsEquivalent", () => {
  const gold = R(["name"], [["a"], ["b"], ["c"]]);

  it("matches an identical result", () => {
    expect(
      resultsEquivalent(R(["name"], [["a"], ["b"], ["c"]]), gold, { ordered: false }).equal,
    ).toBe(true);
  });

  it("is order-insensitive by default", () => {
    expect(
      resultsEquivalent(R(["name"], [["c"], ["a"], ["b"]]), gold, { ordered: false }).equal,
    ).toBe(true);
  });

  it("is order-sensitive when the question demanded an order", () => {
    expect(
      resultsEquivalent(R(["name"], [["c"], ["a"], ["b"]]), gold, { ordered: true }).equal,
    ).toBe(false);
  });

  it("accepts extra columns that still contain the gold answer", () => {
    // The model answered the question and added useful columns. That is a
    // correct answer, not a wrong one.
    const got = R(
      ["id", "name", "runway"],
      [
        [1, "a", 3],
        [2, "b", 4],
        [3, "c", 5],
      ],
    );
    const eq = resultsEquivalent(got, gold, { ordered: false });
    expect(eq.equal).toBe(true);
    expect(eq.reason).toContain("contains the gold answer");
  });

  it("accepts reordered columns", () => {
    const g2 = R(
      ["name", "n"],
      [
        ["a", 1],
        ["b", 2],
      ],
    );
    const got = R(
      ["n", "name"],
      [
        [1, "a"],
        [2, "b"],
      ],
    );
    expect(resultsEquivalent(got, g2, { ordered: false }).equal).toBe(true);
  });

  it("rejects a different row count", () => {
    expect(resultsEquivalent(R(["name"], [["a"], ["b"]]), gold, { ordered: false }).equal).toBe(
      false,
    );
  });

  it("rejects different values", () => {
    expect(
      resultsEquivalent(R(["name"], [["a"], ["b"], ["z"]]), gold, { ordered: false }).equal,
    ).toBe(false);
  });

  it("rejects a result missing a gold column", () => {
    const g2 = R(
      ["name", "n"],
      [
        ["a", 1],
        ["b", 2],
      ],
    );
    const got = R(["name"], [["a"], ["b"]]);
    expect(resultsEquivalent(got, g2, { ordered: false }).equal).toBe(false);
  });

  it("catches columns that are individually right but paired wrongly", () => {
    // Both columns contain the right values, but a/2 and b/1 is a wrong answer.
    const g2 = R(
      ["name", "n"],
      [
        ["a", 1],
        ["b", 2],
      ],
    );
    const got = R(
      ["name", "n"],
      [
        ["a", 2],
        ["b", 1],
      ],
    );
    expect(resultsEquivalent(got, g2, { ordered: false }).equal).toBe(false);
  });

  it("treats two empty results as equal", () => {
    expect(resultsEquivalent(R(["name"], []), R(["name"], []), { ordered: false }).equal).toBe(
      true,
    );
  });

  it("rejects rows where the gold is empty", () => {
    expect(resultsEquivalent(R(["name"], [["a"]]), R(["name"], []), { ordered: false }).equal).toBe(
      false,
    );
  });
});

import { unqualifiedTables } from "../suites/p3.js";

describe("unqualifiedTables", () => {
  it("accepts fully-qualified references", () => {
    expect(
      unqualifiedTables("SELECT a FROM warehouse.main.t JOIN warehouse.main.u ON 1=1"),
    ).toEqual([]);
  });
  it("flags a bare table name", () => {
    expect(unqualifiedTables("SELECT a FROM companies")).toEqual(["companies"]);
  });
  it("exempts a CTE name", () => {
    expect(unqualifiedTables("WITH recent AS (SELECT 1) SELECT * FROM recent")).toEqual([]);
  });
  it("does not mistake EXTRACT(YEAR FROM col) for a table", () => {
    // Regression: this reported "exited_on" as an unqualified table.
    expect(
      unqualifiedTables(
        "SELECT sum(x) FROM warehouse.main.exits WHERE EXTRACT(YEAR FROM exited_on) = 2025",
      ),
    ).toEqual([]);
  });
  it("does not mistake SUBSTRING(s FROM 1) for a table", () => {
    expect(
      unqualifiedTables("SELECT SUBSTRING(name FROM 1 FOR 3) FROM warehouse.main.companies"),
    ).toEqual([]);
  });
  it("ignores a table name inside a string literal", () => {
    expect(unqualifiedTables("SELECT 'from companies' FROM warehouse.main.t")).toEqual([]);
  });
});
