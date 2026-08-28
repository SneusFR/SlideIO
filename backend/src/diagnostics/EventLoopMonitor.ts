/**
 * DEV-ONLY Node event-loop stall detector.
 *
 * A lightweight interval measures its own scheduling drift: when the
 * event loop is blocked (expensive room update, serialization, GC,
 * synchronous code), the interval fires LATE — the drift IS the stall.
 *
 * Reported severities: >50 / >100 / >200 / >500 ms. A stalled backend
 * event loop delays BOTH message receive callbacks and the Colyseus
 * patch interval — the classic cause of "server-side" snapshot bursts.
 *
 * No external dependencies (never add profiling deps for this).
 */

const CHECK_INTERVAL_MS = 25;
/** Ring of recent stalls for the NET_DIAG relay (timestamped, bounded). */
const RECENT_STALLS_MAX = 64;

interface StallEntry {
  at: number; // performance.now()
  ms: number;
}

export class EventLoopMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  /** Cumulative worst stall since start (ms). */
  maxStallMs = 0;
  /** Cumulative counters per severity. */
  over50 = 0;
  over100 = 0;
  over200 = 0;
  over500 = 0;
  private readonly recent: StallEntry[] = [];

  start(): void {
    if (this.timer) return;
    this.lastTick = performance.now();
    this.timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS);
    // Never keep the process alive just for diagnostics.
    this.timer.unref?.();
    console.log("[NET TRACE] Event-loop stall monitor started (dev only)");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Worst stall observed within the last `windowMs` (ms). */
  recentMaxStallMs(windowMs: number): number {
    const cutoff = performance.now() - windowMs;
    let max = 0;
    for (const s of this.recent) {
      if (s.at >= cutoff && s.ms > max) max = s.ms;
    }
    return max;
  }

  private tick(): void {
    const now = performance.now();
    const drift = now - this.lastTick - CHECK_INTERVAL_MS;
    this.lastTick = now;
    if (drift <= 50) return;

    this.maxStallMs = Math.max(this.maxStallMs, drift);
    this.over50++;
    if (drift > 100) this.over100++;
    if (drift > 200) this.over200++;
    if (drift > 500) this.over500++;

    this.recent.push({ at: now, ms: drift });
    if (this.recent.length > RECENT_STALLS_MAX) this.recent.shift();

    const level = drift > 500 ? "CRITICAL" : drift > 200 ? "SEVERE" : drift > 100 ? "WARN" : "notice";
    console.warn(
      `[NET TRACE] EVENT LOOP STALL ${level}: ~${Math.round(drift)}ms ` +
        `(counts >50/100/200/500ms: ${this.over50}/${this.over100}/${this.over200}/${this.over500})`,
    );
  }
}

/** Process-wide singleton — started once in index.ts (dev only). */
export const eventLoopMonitor = new EventLoopMonitor();
