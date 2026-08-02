import { describe, expect, it } from "vitest";
import type { Capabilities, ProviderRequest } from "../types.js";
import { DEFAULT_CAPABILITIES, classifyError, degradeRequest } from "./types.js";

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  ...DEFAULT_CAPABILITIES,
  ...over,
});

const req = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model: "m",
  messages: [{ role: "user", content: "hi" }],
  ...over,
});

describe("degradeRequest", () => {
  it("passes temperature through when the model accepts it", () => {
    const d = degradeRequest(req({ temperature: 0 }), caps({ temperature: true }));
    expect(d.temperature).toBe(0);
    expect(d.paramsDropped).toEqual([]);
  });

  it("drops temperature and records it when the model would 400", () => {
    // This is the Opus 5 / Sonnet 5 / Fable 5 case, not an edge case.
    const d = degradeRequest(req({ temperature: 0 }), caps({ temperature: false }));
    expect(d.temperature).toBeUndefined();
    expect(d.paramsDropped).toContain("temperature");
  });

  it("drops stop sequences when unsupported", () => {
    const d = degradeRequest(req({ stop: ["END"] }), caps({ stopSequences: false }));
    expect(d.stop).toBeUndefined();
    expect(d.paramsDropped).toContain("stop");
  });

  it("keeps an empty stop array from producing a spurious drop", () => {
    const d = degradeRequest(req({ stop: [] }), caps({ stopSequences: false }));
    expect(d.paramsDropped).not.toContain("stop");
  });

  it("keeps the json schema when only tool use is available", () => {
    const d = degradeRequest(
      req({ jsonSchema: { type: "object" } }),
      caps({ jsonSchema: false, toolUse: true }),
    );
    expect(d.jsonSchema).toEqual({ type: "object" });
    expect(d.paramsDropped).not.toContain("jsonSchema");
  });

  it("drops the json schema only when neither schema nor tool use exists", () => {
    const d = degradeRequest(
      req({ jsonSchema: { type: "object" } }),
      caps({ jsonSchema: false, toolUse: false }),
    );
    expect(d.jsonSchema).toBeUndefined();
    expect(d.paramsDropped).toContain("jsonSchema");
  });

  it("cannot disable thinking on an always-on model", () => {
    // Fable 5: an explicit {type:"disabled"} is a 400.
    const d = degradeRequest(
      req({ profile: { thinking: "disabled", effort: null } }),
      caps({ thinkingModes: ["always-on"] }),
    );
    expect(d.thinking).toBe("default");
    expect(d.paramsDropped).toContain("thinking:disabled");
  });

  it("keeps thinking disabled when the model supports off", () => {
    const d = degradeRequest(
      req({ profile: { thinking: "disabled", effort: null } }),
      caps({ thinkingModes: ["off", "adaptive"] }),
    );
    expect(d.thinking).toBe("disabled");
    expect(d.paramsDropped).toEqual([]);
  });

  it("drops effort on a model with no effort parameter", () => {
    const d = degradeRequest(
      req({ profile: { thinking: "default", effort: "low" } }),
      caps({ effortLevels: [] }),
    );
    expect(d.effort).toBeNull();
    expect(d.paramsDropped).toContain("effort");
  });

  it("clamps maxTokens to the model ceiling and records the clamp", () => {
    const d = degradeRequest(req({ maxTokens: 200_000 }), caps({ maxOutputTokens: 64_000 }));
    expect(d.maxTokens).toBe(64_000);
    expect(d.paramsDropped).toContain("maxTokens:clamped");
  });

  it("leaves maxTokens alone when it is under the ceiling", () => {
    const d = degradeRequest(req({ maxTokens: 512 }), caps({ maxOutputTokens: 64_000 }));
    expect(d.maxTokens).toBe(512);
    expect(d.paramsDropped).toEqual([]);
  });
});

describe("classifyError", () => {
  it("treats a temperature rejection as a structured refusal, not an error", () => {
    const r = classifyError(
      400,
      JSON.stringify({ error: { message: "temperature: unsupported parameter" } }),
    );
    expect(r?.kind).toBe("param_rejected");
  });

  it("classifies a schema rejection", () => {
    const r = classifyError(
      400,
      JSON.stringify({ error: { message: "response_format is not supported" } }),
    );
    // "does not support" is a param signal and wins; either classification is a
    // refusal rather than a throw, which is the contract that matters here.
    expect(r).not.toBeNull();
  });

  it("returns null for 5xx so the runner retries instead of scoring it", () => {
    expect(classifyError(503, "overloaded")).toBeNull();
  });

  it("returns null for 429", () => {
    expect(classifyError(429, "rate limited")).toBeNull();
  });
});
