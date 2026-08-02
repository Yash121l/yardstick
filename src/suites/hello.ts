import type { Attempt, GradeResult, ProviderRequest, TaskSpec } from "../types.js";
import { type Suite, type SuiteContext, ungraded } from "./types.js";

const SCHEMA = {
  type: "object",
  properties: { capital: { type: "string" } },
  required: ["capital"],
  additionalProperties: false,
} as const;

/**
 * M0 wiring check: one item, forced JSON schema, temp 0, small output cap.
 * Exercises the whole path — degrade-and-flag, cost metering, cache, grading —
 * for about a tenth of a cent per model.
 */
export const helloSuite: Suite = {
  id: "hello",
  title: "Hello world (wiring check)",
  repeats: 1,
  roles: [],
  requiredParams: ["jsonSchema"],
  estimatedOutputTokensPerItem: 20,
  usesJudge: false,

  async loadItems(_ctx: SuiteContext): Promise<TaskSpec[]> {
    return [
      {
        suite: "hello",
        itemId: "hello-001",
        fixtureVersion: _ctx.fixturesVersion,
        prompt: {
          system: "You return only JSON matching the requested schema.",
          user: 'What is the capital of France? Respond as {"capital": "<city>"}.',
        },
        jsonSchema: SCHEMA as unknown as Record<string, unknown>,
        requestOverrides: { temperature: 0, maxTokens: 256 },
        gold: { capital: "Paris" },
        weight: 1,
      },
    ];
  },

  buildRequest(spec: TaskSpec, modelId: string): ProviderRequest {
    return {
      model: modelId,
      system: spec.prompt.system,
      messages: [{ role: "user", content: spec.prompt.user }],
      jsonSchema: spec.jsonSchema,
      temperature: spec.requestOverrides?.temperature,
      maxTokens: spec.requestOverrides?.maxTokens,
    };
  },

  async grade(spec: TaskSpec, attempt: Attempt): Promise<GradeResult> {
    const res = attempt.response;
    if (!res) return ungraded(spec, attempt, "no response");
    if (res.refusal)
      return ungraded(spec, attempt, `refusal (${res.refusal.kind}): ${res.refusal.detail}`);

    const gold = spec.gold as { capital: string };
    const json = res.json as { capital?: unknown } | undefined;

    if (!json || typeof json.capital !== "string") {
      return {
        attemptId: attempt.attemptId,
        suite: spec.suite,
        itemId: spec.itemId,
        modelId: attempt.modelId,
        status: "graded",
        ungradedReason: null,
        score: 0,
        subscores: { schemaValid: 0 },
        perTrap: {},
        violations: [
          {
            kind: "schema-invalid",
            detail: `expected {capital: string}, got: ${JSON.stringify(res.json ?? res.text)?.slice(0, 200)}`,
            factId: null,
          },
        ],
        evidence: [res.text?.slice(0, 200) ?? ""],
      };
    }

    const correct = json.capital.trim().toLowerCase() === gold.capital.toLowerCase();
    return {
      attemptId: attempt.attemptId,
      suite: spec.suite,
      itemId: spec.itemId,
      modelId: attempt.modelId,
      status: "graded",
      ungradedReason: null,
      score: correct ? 1 : 0,
      subscores: { schemaValid: 1, correct: correct ? 1 : 0 },
      perTrap: {},
      violations: [],
      evidence: [`capital=${json.capital}`],
    };
  },
};
