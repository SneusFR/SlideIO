import { RemoteInterpolationConfig as cfg } from "./RemoteInterpolationConfig";

/**
 * ADAPTIVE interpolation delay (remote players only).
 *
 * The static delay was a compromise: large enough to survive the worst
 * jitter, therefore wasted latency on clean connections. This class
 * measures the REAL conditions and keeps the delay as low as safely
 * possible:
 *
 *   requiredDelay ≈ typicalSnapshotGap + recentJitterEnvelope + margin
 *
 *  - typicalSnapshotGap: smoothed server-timestamp spacing between the
 *    snapshots of active senders (~33 ms at 30 Hz). Idle-suppression
 *    gaps (heartbeats, hidden tabs) are EXCLUDED — they are handled by
 *    extrapolation/freeze, not by delaying everyone.
 *  - jitterEnvelope: decaying MAX of how "late" snapshots arrive w.r.t.
 *    the estimated server clock (burst delivery, patch batching, TCP
 *    head-of-line blocking). A single late burst raises it instantly;
 *    it then decays slowly while the connection stays clean.
 *
 * The APPLIED delay follows the target asymmetrically: it RAISES fast
 * (stutter protection must react now) and LOWERS very slowly (a few
 * ms/s — shifting the remote timeline is invisible at that rate).
 *
 * NEVER affects the local player.
 */
export class AdaptiveInterpolationDelay {
  /** Decaying max of snapshot arrival lateness (ms). */
  private jitterEnvelopeMs = 0;
  /** Smoothed server-ts spacing of active senders (ms). */
  private avgGapMs = 1000 / 30;
  /**
   * Decaying MAX of recent snapshot gaps (ms). The delay must cover the
   * WORST realistic gap, not the average: unaligned 30 Hz sends over a
   * 30 Hz patch rate regularly merge two sends into one patch (~2× gap).
   * With only the smoothed average, renderTime routinely overran the
   * newest snapshot → extrapolation → FREEZE (a mid-air frozen avatar
   * during jumps was the visible symptom). Decays toward the average.
   */
  private gapEnvelopeMs = 1000 / 30;
  /** Currently applied delay (ms) — starts at the static default. */
  private currentDelayMs: number = cfg.interpolationDelayMs;

  /**
   * Feed one FRESH stored snapshot (never duplicates — the caller only
   * reports snapshots actually accepted by a SnapshotBuffer).
   *
   * @param estimatedServerNow NetworkClock.now() at arrival (ms).
   * @param ts     Server timestamp of the snapshot (ms).
   * @param prevTs Server timestamp of the previous snapshot of the SAME
   *               player, or null for the first one.
   */
  noteSnapshot(estimatedServerNow: number, ts: number, prevTs: number | null): void {
    // Arrival lateness: how far behind "server now" this snapshot was
    // when it reached us. The clock offset already absorbs the constant
    // one-way latency — what remains is jitter + patch batching.
    const lateness = estimatedServerNow - ts;
    if (
      lateness > this.jitterEnvelopeMs &&
      lateness <= cfg.adaptiveLatenessCapMs
    ) {
      this.jitterEnvelopeMs = lateness;
    }

    if (prevTs !== null) {
      const gap = ts - prevTs;
      // Ignore idle-suppression / hidden-tab gaps: they are not network
      // conditions and must never inflate everyone's delay.
      if (gap > 0 && gap <= cfg.adaptiveGapCapMs) {
        this.avgGapMs += (gap - this.avgGapMs) * 0.1;
        if (gap > this.gapEnvelopeMs) this.gapEnvelopeMs = gap;
      }
    }
  }

  /**
   * Per render frame: decay the jitter envelope and ease the applied
   * delay toward the target. Returns the delay (ms) to use THIS frame.
   */
  update(dt: number): number {
    this.jitterEnvelopeMs = Math.max(
      0,
      this.jitterEnvelopeMs - cfg.adaptiveJitterDecayMsPerSec * dt,
    );
    // Gap envelope decays toward the smoothed AVERAGE gap (never below):
    // a quiet period slowly re-tightens the delay without ever pretending
    // the worst-case spacing is smaller than the average.
    this.gapEnvelopeMs = Math.max(
      this.avgGapMs,
      this.gapEnvelopeMs - cfg.adaptiveGapDecayMsPerSec * dt,
    );

    const target = clamp(
      this.gapEnvelopeMs + this.jitterEnvelopeMs + cfg.adaptiveSafetyMarginMs,
      cfg.adaptiveDelayMinMs,
      cfg.adaptiveDelayMaxMs,
    );

    if (target > this.currentDelayMs) {
      // Raise FAST: jitter just happened — protect the next frames now.
      this.currentDelayMs = Math.min(
        target,
        this.currentDelayMs + cfg.adaptiveRaiseRateMsPerSec * dt,
      );
    } else {
      // Lower SLOWLY: an imperceptible drift back toward low latency.
      this.currentDelayMs = Math.max(
        target,
        this.currentDelayMs - cfg.adaptiveLowerRateMsPerSec * dt,
      );
    }
    return this.currentDelayMs;
  }

  /** Currently applied delay (ms) — for the debug HUD. */
  get delayMs(): number {
    return this.currentDelayMs;
  }

  reset(): void {
    this.jitterEnvelopeMs = 0;
    this.avgGapMs = 1000 / 30;
    this.gapEnvelopeMs = 1000 / 30;
    this.currentDelayMs = cfg.interpolationDelayMs;
  }
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}