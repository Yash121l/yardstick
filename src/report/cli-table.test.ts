import { describe, expect, it } from "vitest";
import { renderAggregates } from "./cli-table.js";
describe("formatMetric — units that must not be mistaken for each other", () => {
  const cell = (key: string, v: number) =>
    renderAggregates([{ suite: "p4", modelId: "m", metrics: { [key]: v }, cells: {}, notes: [] }]);

  it("renders sub-1 rubric points as points, not as a percentage", () => {
    // 0.514 rubric points of judge disagreement is excellent agreement.
    // Rendered as "51.4" it reads as half the panel disagreeing.
    expect(cell("judgeDisagreementMean", 0.514)).toContain("0.51pt");
    expect(cell("judgeDisagreementMean", 0.514)).not.toContain("51.4");
  });

  it("renders a flagged-item count as a whole number", () => {
    expect(cell("judgeDisagreementFlagged", 0)).toContain("0");
    expect(cell("judgeDisagreementFlagged", 3)).toContain("3");
  });

  it("renders any *Usd metric as currency, not as a rate", () => {
    // $0.214 of judge spend rendered as "21.4" reads as a percentage.
    expect(cell("judgeCostUsd", 0.214)).toContain("$0.214");
    expect(cell("judgeCostUsd", 0.214)).not.toMatch(/\b21\.4\b/);
  });

  it("still renders a genuine 0-1 rate as a percentage", () => {
    expect(cell("deltaClean", 0.708)).toContain("70.8");
  });
});
