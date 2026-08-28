/**
 * DEV-ONLY network diagnostics: lightweight gap-statistics accumulator.
 *
 * Shared between the backend (server receive / patch broadcast gaps) and
 * the frontend (send gaps, patch arrival gaps, snapshot arrival gaps) so
 * every stage of the snapshot pipeline reports IDENTICAL metrics:
 *
 *   avg (EMA) / p95 / p99 / max + counters of gaps >100/200/300/500 ms.
 *
 * All values are DELTAS between consecutive events on the SAME machine —
 * never cross-machine absolute latency (clocks are not comparable).
 *
 * Zero steady-state allocation beyond a bounded window array; the p95/p99
 * sort only happens when a summary is drained (~every 5 s).
 */

/** Point-in-time summary of one gap series (drained window + cumulative). */
export interface GapStatsSummary {
  /** Gaps recorded in the drained window. */
  count: number;
  avgMs: number;
  p95Ms: number;
  p99Ms: number;
  /** Max of the drained window. */
  windowMaxMs: number;
  /** Cumulative max since construction/reset. */
  maxMs: number;
  /** Cumulative counters since construction/reset. */
  over100: number;
  over200: number;
  over300: number;
  over500: number;
}

/** Hard cap on buffered window samples (~5 s at 30 Hz is 150 — huge margin). */
const WINDOW_CAP = 4096;

export class GapStats {
  /** Gaps since the last drainSummary() (bounded). */
  private window: number[] = [];
  /** Smoothed average gap (EMA, ms) — cheap continuous readout. */
  private ema = 0;
  private hasEma = false;

  /** Last recorded gap (ms). */
  lastGapMs = 0;
  /** Cumulative max gap (ms). */
  maxMs = 0;
  /** Cumulative number of recorded gaps. */
  totalCount = 0;
  /** Cumulative threshold counters. */
  over100 = 0;
  over200 = 0;
  over300 = 0;
  over500 = 0;

  /** Record one gap (ms between two consecutive events, same clock). */
  note(gapMs: number): void {
    if (!Number.isFinite(gapMs) || gapMs < 0) return;
    this.lastGapMs = gapMs;
    this.totalCount++;
    if (gapMs > this.maxMs) this.maxMs = gapMs;
    if (gapMs > 100) this.over100++;
    if (gapMs > 200) this.over200++;
    if (gapMs > 300) this.over300++;
    if (gapMs > 500) this.over500++;
    this.ema = this.hasEma ? this.ema + (gapMs - this.ema) * 0.1 : gapMs;
    this.hasEma = true;
    if (this.window.length < WINDOW_CAP) this.window.push(gapMs);
  }

  /** Smoothed average gap (ms) — continuous readout for HUD/diag messages. */
  get avgMs(): number {
    return this.ema;
  }

  /**
   * Summarize + clear the current window (percentiles over the window,
   * cumulative max/counters preserved). Null when nothing was recorded.
   */
  drainSummary(): GapStatsSummary | null {
    if (this.window.length === 0) return null;
    const sorted = [...this.window].sort((a, b) => a - b);
    const n = sorted.length;
    let sum = 0;
    for (const g of sorted) sum += g;
    const pick = (q: number) => sorted[Math.min(n - 1, Math.floor(q * n))];
    const summary: GapStatsSummary = {
      count: n,
      avgMs: sum / n,
      p95Ms: pick(0.95),
      p99Ms: pick(0.99),
      windowMaxMs: sorted[n - 1],
      maxMs: this.maxMs,
      over100: this.over100,
      over200: this.over200,
      over300: this.over300,
      over500: this.over500,
    };
    this.window.length = 0;
    return summary;
  }

  reset(): void {
    this.window.length = 0;
    this.ema = 0;
    this.hasEma = false;
    this.lastGapMs = 0;
    this.maxMs = 0;
    this.totalCount = 0;
    this.over100 = 0;
    this.over200 = 0;
    this.over300 = 0;
    this.over500 = 0;
  }
}

/** Compact "avg/p95/max" formatter used by every 5 s trace summary. */
export function formatGapSummary(s: GapStatsSummary | null): string {
  if (!s) return "no samples";
  return (
    `avg ${s.avgMs.toFixed(0)}ms  p95 ${s.p95Ms.toFixed(0)}ms  p99 ${s.p99Ms.toFixed(0)}ms  ` +
    `max ${s.windowMaxMs.toFixed(0)}ms (all-time ${s.maxMs.toFixed(0)}ms)  ` +
    `>100/200/300/500ms: ${s.over100}/${s.over200}/${s.over300}/${s.over500}`
  );
}
