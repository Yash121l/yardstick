import { describe, expect, it } from "vitest";
import { type Record, type Source, type Store, sync } from "../src/sync.js";

class MemStore implements Store {
  rows: Record[] = [];
  private c = 0;
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

const rows = (n: number): Record[] =>
  Array.from({ length: n }, (_, i) => ({ id: 1 + i, body: `b${1 + i}` }));

describe("sync", () => {
  it("durably writes every record before returning", async () => {
    const store = new MemStore();
    const out = await sync(new MemSource(rows(5)), store);
    expect(out.written).toBe(5);
    expect(store.rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("resumes from the cursor rather than restarting", async () => {
    const store = new MemStore();
    const source = new MemSource(rows(10));
    await sync(source, store, 4);
    await sync(source, store, 4);
    expect(store.rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
