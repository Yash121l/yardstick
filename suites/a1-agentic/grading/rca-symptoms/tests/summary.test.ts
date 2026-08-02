import { beforeEach, describe, expect, it } from "vitest";
import { type Repo, type Row, resetCache, summary } from "../src/summary.js";

const DATA: Row[] = [
  { tenant: "mistfall", window: "2026-08", amountPence: 600_000 },
  { tenant: "orrery", window: "2026-08", amountPence: 4_821_000 },
  { tenant: "pellucid", window: "2026-08", amountPence: 12_500 },
  { tenant: "mistfall", window: "2026-07", amountPence: 111 },
];

class FakeRepo implements Repo {
  calls = 0;
  async rowsFor(tenant: string, window: string): Promise<Row[]> {
    this.calls++;
    return DATA.filter((r) => r.tenant === tenant && r.window === window);
  }
}

beforeEach(() => resetCache());

describe("summary", () => {
  it("returns each tenant's own total", async () => {
    const repo = new FakeRepo();
    expect(await summary(repo, "mistfall", "2026-08", 0)).toBe(600_000);
    expect(await summary(repo, "orrery", "2026-08", 0)).toBe(4_821_000);
    expect(await summary(repo, "pellucid", "2026-08", 0)).toBe(12_500);
  });

  it("does not serve one tenant's total to another", async () => {
    const repo = new FakeRepo();
    await summary(repo, "orrery", "2026-08", 0);
    // Same window, same instant, different tenant. Must not be the cached value.
    expect(await summary(repo, "mistfall", "2026-08", 0)).toBe(600_000);
  });

  it("keeps windows separate for one tenant", async () => {
    const repo = new FakeRepo();
    await summary(repo, "mistfall", "2026-08", 0);
    expect(await summary(repo, "mistfall", "2026-07", 0)).toBe(111);
  });

  it("still caches: a repeat within the TTL does not recompute", async () => {
    const repo = new FakeRepo();
    await summary(repo, "mistfall", "2026-08", 0);
    await summary(repo, "mistfall", "2026-08", 30_000);
    expect(repo.calls).toBe(1);
  });

  it("recomputes after the TTL expires", async () => {
    const repo = new FakeRepo();
    await summary(repo, "mistfall", "2026-08", 0);
    await summary(repo, "mistfall", "2026-08", 61_000);
    expect(repo.calls).toBe(2);
  });
});
