import { describe, expect, it } from "vitest";
import { type Record, type Source, type Store, sync } from "../src/sync.js";

class MemStore implements Store {
  rows: Record[] = [];
  private c = 0;
  /** Writes resolve on a later tick, as a real store would. */
  async put(r: Record): Promise<void> {
    await new Promise((res) => setTimeout(res, 1));
    this.rows.push(r);
  }
  async cursor(): Promise<number> {
    return this.c;
  }
  async setCursor(id: number): Promise<void> {
    this.c = id;
  }
}

class MemSource implements Source {
  constructor(private readonly all: Record[]) {}
  async fetch(after: number, limit: number): Promise<Record[]> {
    return this.all.filter((r) => r.id > after).slice(0, limit);
  }
}

const rows = (n: number, from = 1): Record[] =>
  Array.from({ length: n }, (_, i) => ({ id: from + i, body: `b${from + i}` }));

describe("sync", () => {
  it("durably writes every record before returning", async () => {
    const store = new MemStore();
    const out = await sync(new MemSource(rows(5)), store);
    expect(out.written).toBe(5);
    expect(store.rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("does not advance the cursor past records that are not yet durable", async () => {
    const store = new MemStore();
    await sync(new MemSource(rows(5)), store);
    // Every id at or below the cursor must actually be in the store.
    const cursor = await store.cursor();
    for (let id = 1; id <= cursor; id++) {
      expect(store.rows.some((r) => r.id === id)).toBe(true);
    }
  });

  it("resumes from the cursor rather than restarting", async () => {
    const store = new MemStore();
    const source = new MemSource(rows(10));
    await sync(source, store, 4);
    const afterFirst = await store.cursor();
    expect(afterFirst).toBe(4);
    await sync(source, store, 4);
    expect(store.rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("writes nothing and holds the cursor when the source is drained", async () => {
    const store = new MemStore();
    await store.setCursor(10);
    const out = await sync(new MemSource(rows(10)), store);
    expect(out.written).toBe(0);
    expect(out.cursor).toBe(10);
  });

  it("preserves ordering", async () => {
    const store = new MemStore();
    await sync(new MemSource(rows(8)), store);
    const ids = store.rows.map((r) => r.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });
});
