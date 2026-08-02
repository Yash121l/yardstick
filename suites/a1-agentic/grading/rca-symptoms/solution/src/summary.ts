export interface Row {
  tenant: string;
  window: string;
  amountPence: number;
}

export interface Repo {
  rowsFor(tenant: string, window: string): Promise<Row[]>;
}

interface Entry {
  value: number;
  at: number;
}

/** Process-local cache for the summary endpoint. TTL is one minute. */
const cache = new Map<string, Entry>();
const TTL_MS = 60_000;

export function resetCache(): void {
  cache.clear();
}

export async function summary(
  repo: Repo,
  tenant: string,
  window: string,
  now: number,
): Promise<number> {
  const key = `${tenant}\u0000${window}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) {
    return hit.value;
  }
  const rows = await repo.rowsFor(tenant, window);
  const total = rows.reduce((n, r) => n + r.amountPence, 0);
  cache.set(key, { value: total, at: now });
  return total;
}
