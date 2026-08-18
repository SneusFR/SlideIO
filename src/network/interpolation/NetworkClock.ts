/**
 * Estimated server time (Phase 3).
 *
 * Clients must NOT naively compare their local Date.now() against other
 * clients. Every snapshot carries a SERVER timestamp; this clock estimates
 * "server now" from those timestamps:
 *
 *   offset = serverTimestamp - localNow   (includes one-way latency —
 *                                          constant-ish, which is fine:
 *                                          only ORDER + steady rate matter)
 *   estimatedServerNow = localNow + offset
 *
 * The offset adapts quickly upward (server ahead of the estimate: late
 * join, clock drift) and very slowly downward (jitter must not wobble the
 * remote render time).
 */
export class NetworkClock {
  private offset = Number.NaN;
  /**
   * Newest server timestamp ever ingested (monotonic guard).
   *
   * CRITICAL: callers feed the clock from SYNCED STATE every render frame,
   * so the SAME timestamp arrives hundreds of times while a sender is idle
   * (transform idle-suppression). Each repeat used to be re-sampled as
   * `staleTs - performance.now()` — a value that recedes 1 ms per ms — and
   * dragged the offset DOWN 2% per frame. The estimated server time then
   * asymptotically FROZE at the stale timestamp, freezing renderTime and
   * pinning every remote avatar mid-trajectory (the "remote player hangs
   * in the air after landing" bug). A timestamp that is not strictly newer
   * than the newest one already ingested carries no clock information and
   * MUST be ignored.
   */
  private lastFedTs = -Infinity;

  /** Feed every fresh server timestamp received (ms, server clock). */
  noteServerTimestamp(serverTimeMs: number): void {
    if (serverTimeMs <= this.lastFedTs) return; // stale/repeated → no info
    this.lastFedTs = serverTimeMs;

    const sample = serverTimeMs - performance.now();
    if (Number.isNaN(this.offset)) {
      this.offset = sample;
    } else if (sample > this.offset) {
      this.offset += (sample - this.offset) * 0.35; // catch up quickly
    } else {
      this.offset += (sample - this.offset) * 0.02; // drift down very slowly
    }
  }

  get hasSync(): boolean {
    return !Number.isNaN(this.offset);
  }

  /** Estimated current server time (ms). 0 before the first sample. */
  now(): number {
    return Number.isNaN(this.offset) ? 0 : performance.now() + this.offset;
  }

  reset(): void {
    this.offset = Number.NaN;
    this.lastFedTs = -Infinity;
  }
}