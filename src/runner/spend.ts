/** Thrown when the hard USD cap is reached. The runner aborts cleanly. */
export class SpendCapExceeded extends Error {
  constructor(
    readonly spent: number,
    readonly cap: number,
  ) {
    super(`spend cap reached: $${spent.toFixed(4)} of $${cap.toFixed(2)}`);
  }
}

/**
 * Hard per-run cap computed from LIVE usage counts times registry prices —
 * never from an estimate. `reserve()` is called before a call is dispatched so
 * we stop at the cap instead of just noticing afterwards.
 */
export class SpendMeter {
  private spent = 0;
  private aborted = false;

  constructor(readonly cap: number) {}

  get total(): number {
    return this.spent;
  }

  get isAborted(): boolean {
    return this.aborted;
  }

  /** Returns false when the cap is already reached; the caller stops dispatching. */
  reserve(): boolean {
    if (this.spent >= this.cap) {
      this.aborted = true;
      return false;
    }
    return true;
  }

  add(costUsd: number): void {
    this.spent += costUsd;
    if (this.spent >= this.cap) this.aborted = true;
  }

  assertUnderCap(): void {
    if (this.spent >= this.cap) throw new SpendCapExceeded(this.spent, this.cap);
  }
}
