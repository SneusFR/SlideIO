import { GapStats } from "../../../shared/diagnostics/GapStats";

/**
 * DEV-ONLY frontend trace hub for the remote-player snapshot pipeline.
 *
 * Collects gap statistics for every CLIENT-side stage and mirrors the
 * SERVER-side stats relayed via the throttled NET_DIAG message:
 *
 *   local send gap → [server rx gap / server tx gap: NET_DIAG] →
 *   patch arrival gap → per-remote stored-snapshot gap → buffer events.
 *
 * Every ~5 s a compact [NET TRACE] summary is printed per player so the
 * broken stage (normal ~33 ms avg but 300+ ms max) is immediately visible.
 *
 * ALL methods are no-ops outside Vite dev builds — zero production cost.
 */

/** Server-side per-player stats relayed by the backend (NET_DIAG). */
export interface ServerPlayerDiag {
  id: string;
  rxAvgMs: number;
  rxMaxMs: number;
  rxLastGapMs: number;
  txAvgMs: number;
  txMaxMs: number;
  txLastGapMs: number;
  seqDup: number;
  seqBack: number;
  seqGapTotal: number;
  coalescedTotal: number;
}

/** Full NET_DIAG payload. */
export interface ServerDiag {
  players: ServerPlayerDiag[];
  patchAvgMs: number;
  patchMaxMs: number;
  loopStallMs: number;
  /** Server-side combat msgs/s (WEAPON_ACTION in / confirms+feedback out).
   *  Optional: older servers don't send them (-1 = unavailable). */
  combatRxPerSec?: number;
  combatTxPerSec?: number;
  /** Worst per-client outbound ws bufferedAmount (bytes, -1 = N/A). */
  wsBufferedMax?: number;
}

/** Per-remote pipeline row for the F1 PIPELINE overlay section. */
export interface PipelinePlayerDebug {
  id: string;
  serverRxAvgMs: number;
  serverRxMaxMs: number;
  serverTxAvgMs: number;
  serverTxMaxMs: number;
  clientRxAvgMs: number;
  clientRxMaxMs: number;
  coalesced: number;
  seqDup: number;
  seqBack: number;
  seqGapTotal: number;
  extrapEvents: number;
  extrapLongestMs: number;
  maxCorrectionM: number;
  bursts: number;
}

/** Pipeline block attached to the F1 network debug report (DEV only). */
export interface NetPipelineDebug {
  sendAvgMs: number;
  sendMaxMs: number;
  sendLastGapMs: number;
  sendCount: number;
  suppressedCount: number;
  serverPatchAvgMs: number;
  serverPatchMaxMs: number;
  serverLoopStallMs: number;
  patchArrivalAvgMs: number;
  patchArrivalMaxMs: number;
  // ---- Combat message rates (aggregated ~1 s windows, never per-packet) --
  /** LOCAL combat messages sent per second (WEAPON_ACTION out). */
  combatUpPerSec: number;
  /** Combat messages received per second (confirms + hit/damage/impulse). */
  combatDownPerSec: number;
  /** SERVER combat msgs/s relayed via NET_DIAG (-1 = no data yet). */
  serverCombatRxPerSec: number;
  serverCombatTxPerSec: number;
  // ---- WebSocket outbound backlog (bytes; -1 = unavailable) ----
  /** LOCAL socket bufferedAmount at report time. */
  clientWsBufferedBytes: number;
  /** Peak LOCAL bufferedAmount observed since the last report. */
  clientWsBufferedMaxBytes: number;
  /** Worst per-client backlog on the SERVER (NET_DIAG relay). */
  serverWsBufferedMaxBytes: number;
  players: PipelinePlayerDebug[];
}

/** Burst definition: ≥3 arrivals within 25 ms right after a >100 ms gap. */
const BURST_GAP_MS = 100;
const BURST_WINDOW_MS = 25;
const BURST_MIN_COUNT = 3;
/** Console summary interval (ms). */
const SUMMARY_INTERVAL_MS = 5000;

class RemoteTrace {
  /** Client-side stored-snapshot arrival gaps (wall clock). */
  readonly rx = new GapStats();
  extrapEvents = 0;
  extrapLongestMs = 0;
  maxCorrectionM = 0;
  seqGapTotal = 0;
  bursts = 0;
  /** Burst detection state. */
  burstStartAt = 0;
  burstCount = 0;
}

/**
 * TEMPORARY: tracing is force-enabled in PRODUCTION too while the
 * "200–500 ms snapshot gap then burst" issue is being diagnosed on the
 * live site (the bug only reproduces over the real Internet). Revert to
 * `import.meta.env.DEV === true` once the pipeline stage is identified.
 */
export const NET_TRACE_ENABLED = true;

class NetTrace {
  private readonly enabled: boolean = NET_TRACE_ENABLED;

  /** Local movement send gaps (actual sends only, suppression excluded). */
  readonly sendGap = new GapStats();
  private sendCount = 0;
  private suppressedCount = 0;

  /** Patch arrival gaps (every applied Colyseus state patch). */
  readonly patchArrival = new GapStats();
  private lastPatchAt = 0;
  private patchBurstStartAt = 0;
  private patchBurstCount = 0;
  private patchBursts = 0;

  private readonly remotes = new Map<string, RemoteTrace>();
  private serverDiag: ServerDiag | null = null;
  private lastSummaryAt = 0;

  // ---- Combat message counters (rolling ~1 s windows — cheap ints) ----
  private combatUpCount = 0;
  private combatDownCount = 0;
  private combatWindowStartAt = 0;
  /** Last completed window's rates (what the HUD displays). */
  private combatUpPerSecValue = 0;
  private combatDownPerSecValue = 0;

  // ---- WebSocket backlog sampling (local socket) ----
  /** Provider wired by MultiplayerClient (returns bufferedAmount or -1). */
  private wsBufferedProvider: (() => number) | null = null;
  /** Peak bufferedAmount observed since the last pipeline report. */
  private wsBufferedPeak = -1;

  // ---- Stage 2: client send ----

  noteLocalSend(gapMs: number): void {
    if (!this.enabled) return;
    this.sendCount++;
    if (gapMs > 0) this.sendGap.note(gapMs);
  }

  noteSuppressedTick(): void {
    if (!this.enabled) return;
    this.suppressedCount++;
  }

  // ---- Stage 5: patch arrival on the receiving client ----

  /** @returns arrival gap (ms) or 0 for the first patch. */
  notePatchArrival(): number {
    if (!this.enabled) return 0;
    const now = performance.now();
    let gap = 0;
    if (this.lastPatchAt > 0) {
      gap = now - this.lastPatchAt;
      this.patchArrival.note(gap);
      // Burst: long silence, then several patches almost together.
      if (gap > BURST_GAP_MS) {
        this.patchBurstStartAt = now;
        this.patchBurstCount = 1;
      } else if (this.patchBurstStartAt > 0 && now - this.patchBurstStartAt <= BURST_WINDOW_MS) {
        this.patchBurstCount++;
        if (this.patchBurstCount === BURST_MIN_COUNT) this.patchBursts++;
      } else {
        this.patchBurstStartAt = 0;
        this.patchBurstCount = 0;
      }
    }
    this.lastPatchAt = now;
    return gap;
  }

  // ---- Stage 5/6: per-remote stored snapshots + buffer events ----

  /** @returns true when this arrival completed a BURST (report upstream). */
  noteRemoteSnapshot(id: string, arrivalGapMs: number): boolean {
    if (!this.enabled || arrivalGapMs <= 0) return false;
    const t = this.remote(id);
    t.rx.note(arrivalGapMs);
    const now = performance.now();
    if (arrivalGapMs > BURST_GAP_MS) {
      t.burstStartAt = now;
      t.burstCount = 1;
    } else if (t.burstStartAt > 0 && now - t.burstStartAt <= BURST_WINDOW_MS) {
      t.burstCount++;
      if (t.burstCount === BURST_MIN_COUNT) {
        t.bursts++;
        return true;
      }
    } else {
      t.burstStartAt = 0;
      t.burstCount = 0;
    }
    return false;
  }

  noteExtrapolationEpisode(id: string, durationMs: number): void {
    if (!this.enabled) return;
    const t = this.remote(id);
    t.extrapEvents++;
    if (durationMs > t.extrapLongestMs) t.extrapLongestMs = durationMs;
  }

  noteCorrection(id: string, meters: number): void {
    if (!this.enabled) return;
    const t = this.remote(id);
    if (meters > t.maxCorrectionM) t.maxCorrectionM = meters;
  }

  noteSeqGap(id: string, missing: number): void {
    if (!this.enabled) return;
    this.remote(id).seqGapTotal += missing;
  }

  // ---- Combat message rate (aggregated windows, zero per-packet cost) ----

  /** One combat message SENT by the local client (WEAPON_ACTION). */
  noteCombatMessageSent(): void {
    if (!this.enabled) return;
    this.rollCombatWindow();
    this.combatUpCount++;
  }

  /** One combat message RECEIVED (confirm / hit / damage / impulse). */
  noteCombatMessageReceived(): void {
    if (!this.enabled) return;
    this.rollCombatWindow();
    this.combatDownCount++;
  }

  /** Close the ~1 s aggregation window when it has elapsed. */
  private rollCombatWindow(): void {
    const now = performance.now();
    if (this.combatWindowStartAt === 0) {
      this.combatWindowStartAt = now;
      return;
    }
    const elapsed = now - this.combatWindowStartAt;
    if (elapsed < 1000) return;
    const seconds = elapsed / 1000;
    this.combatUpPerSecValue = Math.round(this.combatUpCount / seconds);
    this.combatDownPerSecValue = Math.round(this.combatDownCount / seconds);
    this.combatUpCount = 0;
    this.combatDownCount = 0;
    this.combatWindowStartAt = now;
  }

  // ---- WebSocket backlog (local socket bufferedAmount) ----

  /** Wire the local bufferedAmount reader (MultiplayerClient owns the ws). */
  setWsBufferedProvider(provider: (() => number) | null): void {
    this.wsBufferedProvider = provider;
    this.wsBufferedPeak = -1;
  }

  /**
   * Cheap periodic sample (called from update(), a few times per second):
   * tracks the PEAK backlog between two F1 refreshes so short spikes
   * are never missed by the 250 ms HUD polling.
   */
  private sampleWsBuffered(): void {
    if (!this.wsBufferedProvider) return;
    const buffered = this.wsBufferedProvider();
    if (buffered > this.wsBufferedPeak) this.wsBufferedPeak = buffered;
  }

  // ---- Server relay + reporting ----

  setServerDiag(diag: ServerDiag): void {
    if (!this.enabled) return;
    this.serverDiag = diag;
  }

  /** Pipeline block for the F1 HUD (called at HUD refresh rate only). */
  buildPipelineDebug(): NetPipelineDebug | null {
    if (!this.enabled) return null;
    const players: PipelinePlayerDebug[] = [];
    for (const [id, t] of this.remotes) {
      const sv = this.serverDiag?.players.find((p) => p.id === id);
      players.push({
        id,
        serverRxAvgMs: sv?.rxAvgMs ?? -1,
        serverRxMaxMs: sv?.rxMaxMs ?? -1,
        serverTxAvgMs: sv?.txAvgMs ?? -1,
        serverTxMaxMs: sv?.txMaxMs ?? -1,
        clientRxAvgMs: Math.round(t.rx.avgMs),
        clientRxMaxMs: Math.round(t.rx.maxMs),
        coalesced: sv?.coalescedTotal ?? -1,
        seqDup: sv?.seqDup ?? -1,
        seqBack: sv?.seqBack ?? -1,
        seqGapTotal: t.seqGapTotal,
        extrapEvents: t.extrapEvents,
        extrapLongestMs: Math.round(t.extrapLongestMs),
        maxCorrectionM: t.maxCorrectionM,
        bursts: t.bursts,
      });
    }
    // Fresh backlog sample + drain the peak observed since the last report.
    this.sampleWsBuffered();
    const wsNow = this.wsBufferedProvider ? this.wsBufferedProvider() : -1;
    const wsPeak = this.wsBufferedPeak;
    this.wsBufferedPeak = wsNow;
    this.rollCombatWindow();
    return {
      sendAvgMs: Math.round(this.sendGap.avgMs),
      sendMaxMs: Math.round(this.sendGap.maxMs),
      sendLastGapMs: Math.round(this.sendGap.lastGapMs),
      sendCount: this.sendCount,
      suppressedCount: this.suppressedCount,
      serverPatchAvgMs: this.serverDiag?.patchAvgMs ?? -1,
      serverPatchMaxMs: this.serverDiag?.patchMaxMs ?? -1,
      serverLoopStallMs: this.serverDiag?.loopStallMs ?? -1,
      patchArrivalAvgMs: Math.round(this.patchArrival.avgMs),
      patchArrivalMaxMs: Math.round(this.patchArrival.maxMs),
      combatUpPerSec: this.combatUpPerSecValue,
      combatDownPerSec: this.combatDownPerSecValue,
      serverCombatRxPerSec: this.serverDiag?.combatRxPerSec ?? -1,
      serverCombatTxPerSec: this.serverDiag?.combatTxPerSec ?? -1,
      clientWsBufferedBytes: wsNow,
      clientWsBufferedMaxBytes: wsPeak,
      serverWsBufferedMaxBytes: this.serverDiag?.wsBufferedMax ?? -1,
      players,
    };
  }

  /** Per-frame heartbeat: peak-samples the ws backlog + ~5 s summaries. */
  update(): void {
    if (!this.enabled) return;
    // Track the PEAK outbound backlog between HUD refreshes (one property
    // read per frame — negligible; short spikes must not be missed).
    this.sampleWsBuffered();
    const now = performance.now();
    if (now - this.lastSummaryAt < SUMMARY_INTERVAL_MS) return;
    // Nothing to report before any traffic.
    if (this.sendCount === 0 && this.remotes.size === 0) return;
    this.lastSummaryAt = now;
    this.logSummary();
  }

  removeRemote(id: string): void {
    this.remotes.delete(id);
  }

  reset(): void {
    this.sendGap.reset();
    this.patchArrival.reset();
    this.remotes.clear();
    this.serverDiag = null;
    this.sendCount = 0;
    this.suppressedCount = 0;
    this.lastPatchAt = 0;
    this.patchBurstStartAt = 0;
    this.patchBurstCount = 0;
    this.patchBursts = 0;
    this.lastSummaryAt = 0;
    this.combatUpCount = 0;
    this.combatDownCount = 0;
    this.combatWindowStartAt = 0;
    this.combatUpPerSecValue = 0;
    this.combatDownPerSecValue = 0;
    this.wsBufferedProvider = null;
    this.wsBufferedPeak = -1;
  }

  // ------------------------------------------------------------------

  private logSummary(): void {
    const send = this.sendGap.drainSummary();
    const patch = this.patchArrival.drainSummary();
    const fmt = (s: ReturnType<GapStats["drainSummary"]>): string =>
      s
        ? `avg ${s.avgMs.toFixed(0)}ms  p95 ${s.p95Ms.toFixed(0)}ms  p99 ${s.p99Ms.toFixed(0)}ms  ` +
          `max ${s.windowMaxMs.toFixed(0)}ms (all-time ${s.maxMs.toFixed(0)}ms)  ` +
          `>100/200/300/500ms: ${s.over100}/${s.over200}/${s.over300}/${s.over500}`
        : "no samples";

    const sv = this.serverDiag;
    console.log(
      `[NET TRACE LOCAL]\n` +
        `  Client send:    ${fmt(send)}  (sends ${this.sendCount}, idle-suppressed ${this.suppressedCount})\n` +
        `  Patch arrival:  ${fmt(patch)}  (bursts ${this.patchBursts})\n` +
        (sv
          ? `  Server (relay): patch avg ${sv.patchAvgMs}ms  max ${sv.patchMaxMs}ms  loop stall(5s) ${sv.loopStallMs}ms`
          : `  Server (relay): no NET_DIAG received yet`),
    );

    for (const [id, t] of this.remotes) {
      const rx = t.rx.drainSummary();
      const svp = sv?.players.find((p) => p.id === id);
      console.log(
        `[NET TRACE PLAYER ${id}]\n` +
          (svp
            ? `  Server receive:  avg ${svp.rxAvgMs}ms  max ${svp.rxMaxMs}ms  ` +
              `seq dup/back/gap ${svp.seqDup}/${svp.seqBack}/${svp.seqGapTotal}\n` +
              `  Server outbound: avg ${svp.txAvgMs}ms  max ${svp.txMaxMs}ms  ` +
              `coalesced ${svp.coalescedTotal}\n`
            : `  Server side:     no NET_DIAG data\n`) +
          `  Client receive:  ${fmt(rx)}  (bursts ${t.bursts})\n` +
          `  SnapshotBuffer:  extrap events ${t.extrapEvents}  longest ${Math.round(t.extrapLongestMs)}ms  ` +
          `max correction ${t.maxCorrectionM.toFixed(1)}m  seq gaps ${t.seqGapTotal}`,
      );
    }
  }

  private remote(id: string): RemoteTrace {
    let t = this.remotes.get(id);
    if (!t) {
      t = new RemoteTrace();
      this.remotes.set(id, t);
    }
    return t;
  }
}

/** Singleton — one multiplayer session at a time (reset on session end). */
export const netTrace = new NetTrace();
