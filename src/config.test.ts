import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, validateProfile } from "./config.js";
import type { ModelEntry } from "./types.js";

const entry = (over: Partial<ModelEntry>): ModelEntry =>
  ({
    id: "m",
    provider: "anthropic",
    family: "anthropic",
    priceIn: 1,
    priceOut: 1,
    priceCachedIn: null,
    baseline: false,
    roles: [],
    profile: { thinking: "default", effort: null },
    ...over,
  }) as ModelEntry;

describe("validateProfile", () => {
  it("accepts a plain profile", () => {
    expect(validateProfile(entry({}))).toEqual([]);
  });

  it("rejects thinking=disabled paired with xhigh effort", () => {
    // Opus 5 returns 400 for this combination. Catch it before any spend.
    const errs = validateProfile(entry({ profile: { thinking: "disabled", effort: "xhigh" } }));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("Disabling thinking above effort");
  });

  it("rejects thinking=disabled paired with max effort", () => {
    expect(
      validateProfile(entry({ profile: { thinking: "disabled", effort: "max" } })),
    ).toHaveLength(1);
  });

  it("accepts thinking=disabled at effort high", () => {
    expect(validateProfile(entry({ profile: { thinking: "disabled", effort: "high" } }))).toEqual(
      [],
    );
  });

  it("rejects disabling thinking on an always-on model", () => {
    const errs = validateProfile(
      entry({
        profile: { thinking: "disabled", effort: null },
        capabilities: { thinkingModes: ["always-on"] },
      }),
    );
    expect(errs[0]).toContain('does not include "off"');
  });

  it("rejects an effort level the model does not have", () => {
    const errs = validateProfile(
      entry({
        profile: { thinking: "default", effort: "xhigh" },
        capabilities: { effortLevels: ["low", "medium", "high"] },
      }),
    );
    expect(errs[0]).toContain("is not one of");
  });

  it("rejects effort on a model with no effort parameter", () => {
    const errs = validateProfile(
      entry({
        profile: { thinking: "default", effort: "low" },
        capabilities: { effortLevels: [] },
      }),
    );
    expect(errs[0]).toContain("no effort parameter");
  });
});

describe("baseline ambiguity", () => {
  it("rejects two baselines for the same role instead of picking one", () => {
    // `baseline` is one flag but `roles` is a list, so the classify baseline
    // silently became the vision baseline too and verdicts compared against an
    // incumbent nobody chose.
    const dir = mkdtempSync(join(tmpdir(), "ys-cfg-"));
    writeFileSync(
      join(dir, "models.yaml"),
      [
        "- id: a",
        "  provider: anthropic",
        "  family: anthropic",
        "  priceIn: 1",
        "  priceOut: 1",
        "  baseline: true",
        "  roles: [classify, vision]",
        "- id: b",
        "  provider: anthropic",
        "  family: anthropic",
        "  priceIn: 3",
        "  priceOut: 3",
        "  baseline: true",
        "  roles: [extract, vision]",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "judges.yaml"),
      [
        "primary:",
        "  id: j",
        "  provider: anthropic",
        "  family: anthropic",
        "  priceIn: 1",
        "  priceOut: 1",
        'rubricVersion: "1"',
      ].join("\n"),
    );
    writeFileSync(join(dir, "fixtures.VERSION"), "2\n");

    expect(() => loadConfig(dir)).toThrow(/more than one baseline/);
    expect(() => loadConfig(dir)).toThrow(/vision: a, b/);
  });

  it("accepts the same pair once baselineRoles disambiguates them", () => {
    const dir = mkdtempSync(join(tmpdir(), "ys-cfg-"));
    writeFileSync(
      join(dir, "models.yaml"),
      [
        "- id: a",
        "  provider: anthropic",
        "  family: anthropic",
        "  priceIn: 1",
        "  priceOut: 1",
        "  baseline: true",
        "  roles: [classify, vision]",
        "  baselineRoles: [classify]",
        "- id: b",
        "  provider: anthropic",
        "  family: anthropic",
        "  priceIn: 3",
        "  priceOut: 3",
        "  baseline: true",
        "  roles: [extract, vision]",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "judges.yaml"),
      [
        "primary:",
        "  id: j",
        "  provider: anthropic",
        "  family: anthropic",
        "  priceIn: 1",
        "  priceOut: 1",
        'rubricVersion: "1"',
      ].join("\n"),
    );
    writeFileSync(join(dir, "fixtures.VERSION"), "2\n");
    expect(() => loadConfig(dir)).not.toThrow();
  });
});
