/** Minimal counting semaphore. One instance per provider. */
export class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(readonly limit: number) {
    if (limit < 1) throw new Error(`concurrency limit must be >= 1, got ${limit}`);
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    return () => this.release();
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class SemaphorePool {
  private pool = new Map<string, Semaphore>();

  constructor(private readonly limit: number) {}

  for(key: string): Semaphore {
    let s = this.pool.get(key);
    if (!s) {
      s = new Semaphore(this.limit);
      this.pool.set(key, s);
    }
    return s;
  }
}
