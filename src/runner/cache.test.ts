import { describe, expect, it } from "vitest";
import { isCacheable } from "./cache.js";
describe("isCacheable — which refusals may be stored", () => {
  it("caches a content refusal: the model will decline the same text again", () => {
    expect(isCacheable({ refusal: { kind: "content" } })).toBe(true);
  });

  it("refuses to cache a param rejection, which is our bug not the model's", () => {
    // Caching this is how a corrected capability table appears to change
    // nothing: the stale refusal replays with its original request_id.
    expect(isCacheable({ refusal: { kind: "param_rejected" } })).toBe(false);
    expect(isCacheable({ refusal: { kind: "schema_unsupported" } })).toBe(false);
  });

  it("DOES cache a param rejection from a P6 probe, where it is the measurement", () => {
    expect(isCacheable({ refusal: { kind: "param_rejected" } }, { probeRaw: true })).toBe(true);
  });

  it("caches an ordinary successful response", () => {
    expect(isCacheable({})).toBe(true);
    expect(isCacheable({ refusal: null })).toBe(true);
  });
});
