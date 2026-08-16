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

  /** Feed every fresh server timestamp received (ms, server clock). */
  noteServerTimestamp(serverTimeMs: number): void {
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
  }
}