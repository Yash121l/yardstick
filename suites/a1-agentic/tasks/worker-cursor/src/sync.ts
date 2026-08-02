export interface Record {
  id: number;
  body: string;
}

export interface Store {
  put(r: Record): Promise<void>;
  /** Highest id durably written, or 0 when the store is empty. */
  cursor(): Promise<number>;
  setCursor(id: number): Promise<void>;
}

export interface Source {
  /** Records with id > after, ascending, at most `limit` of them. */
  fetch(after: number, limit: number): Promise<Record[]>;
}

export interface SyncResult {
  written: number;
  cursor: number;
}

/**
 * Drain the source into the store.
 *
 * Called on a timer. A run may be interrupted at any point — the process is
 * recycled regularly — and the next run must pick up where this one stopped.
 */
export async function sync(source: Source, store: Store, limit = 100): Promise<SyncResult> {
  let written = 0;
  const start = await store.cursor();
  const batch = await source.fetch(start, limit);

  for (const r of batch) {
    // Fire-and-forget: the loop does not wait for the write to land.
    void store.put(r);
    written++;
  }

  if (batch.length > 0) {
    await store.setCursor(batch[batch.length - 1]!.id);
  }

  return { written, cursor: await store.cursor() };
}
