export interface Record {
  id: number;
  body: string;
}

export interface Store {
  put(r: Record): Promise<void>;
  cursor(): Promise<number>;
  setCursor(id: number): Promise<void>;
}

export interface Source {
  fetch(after: number, limit: number): Promise<Record[]>;
}

export interface SyncResult {
  written: number;
  cursor: number;
}

/** Reference solution: await each write, advance the cursor per durable record. */
export async function sync(source: Source, store: Store, limit = 100): Promise<SyncResult> {
  let written = 0;
  const start = await store.cursor();
  const batch = await source.fetch(start, limit);

  for (const r of batch) {
    await store.put(r);
    await store.setCursor(r.id);
    written++;
  }

  return { written, cursor: await store.cursor() };
}
