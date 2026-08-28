import { GapStats, formatGapSummary, GapStatsSummary } from "../../../shared/diagnostics/GapStats";

/**
 * DEV-ONLY server-side movement snapshot pipeline trace (one per room).
 *
 * Answers two questions the client alone cannot:
 *   1. RECEIVE  — "did the sender's messages stop ARRIVING at the server?"
 *      (per-player gap between consecutive PLAYER_TRANSFORM messages, plus
 *      the SENDER-CLOCK spacing `cts` so a network stall [server gap big,
 *      cts gap small] is distinguishable from a sender stall [both big]).
 *   2. BROADCAST — "did the server hold the data before patching it out?"
 *      (per-player gap between consecutive patches CARRYING that player's
 *      transform + mutation→patch latency + explicit COALESCING counter:
 *      several receives merged into one schema patch — expected Colyseus
 *      behavior at 30 Hz send over 30 Hz patch, NOT packet loss).
 *
 * Cross-machine clocks are never compared: every metric is a DELTA between
 * consecutive events on the same clock.
 */

/** Receive-gap anomaly thresholds (ms). */
const RX_GAP_NOTICE = 75;
const RX_GAP_WARN = 150;
const RX_GAP_SEVERE = 250;
/** Console summary interval (ms). */
const SUMMARY_INTERVAL_MS = 5000;
/** Min interval between per-player anomaly console lines (ms) — no spam. */
const ANOMALY_THROTTLE_MS = 500;

/** Per-player NET_DIAG payload relayed to clients (see GameRoom). */
export interface ServerPlayerDiag {
  id: string;
  /** Server receive gaps (ms). */
  rxAvgMs: number;
  rxMaxMs: number;
  rxLastGapMs: number;
  /** Server outbound (patch-carrying) gaps (ms). */
  txAvgMs: number;
  txMaxMs: number;
  txLastGapMs: number;
  /** Seq bookkeeping observed at RECEIVE time. */
  seqDup: number;
  seqBack: number;
  seqGapTotal: number;
  /** Receives overwritten before serialization (Colyseus coalescing). */
  coalescedTotal: number;
}

class PlayerTrace {
  readonly rx = new GapStats();
  readonly tx = new GapStats();
  /** Mutation→patch latency (state written vs actually serialized). */
  readonly mutationToPatch = new GapStats();
  /** Sender-clock (cts) spacing between received transforms. */
  readonly senderClockGap = new GapStats();
  lastRxAt = 0;
  lastTxAt = 0;
  lastSeq = -1;
  lastCts: number | null = null;
  seqDup = 0;
  seqBack = 0;
  seqGapTotal = 0;
  /** Receives since the last patch that carried this player (dirty). */
  receivesSinceLastPatch = 0;
  /** performance.now() of the FIRST mutation since the last carry-patch. */
  earliestMutationAt = 0;
  coalescedTotal = 0;
  lastAnomalyLogAt = 0;
}

export class ServerTransformTrace {
  private readonly players = new Map<string, PlayerTrace>();
  /** Room-global gap between consecutive patch broadcasts. */
  readonly patchGap = new GapStats();
  private lastPatchAt = 0;
  private lastSummaryAt = 0;

  constructor(private readonly roomId: string) {}

  /**
   * Called from GameRoom.handlePlayerTransform for EVERY structurally valid
   * transform (even ones the seq guard then rejects — duplicates/backwards
   * must be counted at the receive stage). `applied` = the message actually
   * mutated the room state (and will therefore ride the next patch).
   */
  noteReceive(
    playerId: string,
    playerName: string,
    seq: number,
    cts: number | null,
    applied: boolean,
  ): void {
    const now = performance.now();
    let t = this.players.get(playerId);
    if (!t) {
      t = new PlayerTrace();
      this.players.set(playerId, t);
    }

    // ---- Receive gap (server clock) ----
    if (t.lastRxAt > 0) {
      const gap = now - t.lastRxAt;
      t.rx.note(gap);
      if (gap > RX_GAP_NOTICE && now - t.lastAnomalyLogAt >= ANOMALY_THROTTLE_MS) {
        t.lastAnomalyLogAt = now;
        const level = gap > RX_GAP_SEVERE ? "SEVERE" : gap > RX_GAP_WARN ? "WARN" : "notice";
        // Sender-clock spacing tells WHERE the gap was born: cts gap ≈ rx
        // gap → the SENDER paused; cts gap small → the NETWORK stalled and
        // TCP delivered late (messages will now arrive in a burst).
        const ctsInfo =
          cts !== null && t.lastCts !== null
            ? ` senderClockGap=${Math.round(cts - t.lastCts)}ms`
            : "";
        console.warn(
          `[NET TRACE ${this.roomId}] SERVER RX GAP ${level} ${playerName}: ` +
            `${Math.round(gap)}ms (seq ${seq})${ctsInfo}`,
        );
      }
    }
    t.lastRxAt = now;

    // ---- Sender-clock spacing (deltas of the SENDER's clock only) ----
    if (cts !== null) {
      if (t.lastCts !== null) {
        const ctsGap = cts - t.lastCts;
        if (ctsGap >= 0) t.senderClockGap.note(ctsGap);
      }
      t.lastCts = cts;
    }

    // ---- Seq contiguity (NOTE: gaps at this stage mean the CLIENT never
    // sent them or the connection dropped — never UDP-style loss) ----
    if (t.lastSeq >= 0) {
      if (seq === t.lastSeq) t.seqDup++;
      else if (seq < t.lastSeq) t.seqBack++;
      else if (seq > t.lastSeq + 1) t.seqGapTotal += seq - t.lastSeq - 1;
    }
    t.lastSeq = seq;

    // ---- Broadcast-side dirty bookkeeping (applied mutations only) ----
    if (applied) {
      if (t.receivesSinceLastPatch === 0) t.earliestMutationAt = now;
      t.receivesSinceLastPatch++;
    }
  }

  /**
   * Called from the GameRoom.broadcastPatch override AFTER the patch was
   * serialized+sent. Records, for every player whose transform the patch
   * carried, the outbound gap + mutation→patch latency + coalescing.
   */
  notePatchBroadcast(): void {
    const now = performance.now();
    if (this.lastPatchAt > 0) this.patchGap.note(now - this.lastPatchAt);
    this.lastPatchAt = now;

    for (const t of this.players.values()) {
      if (t.receivesSinceLastPatch === 0) continue; // not carried this patch
      if (t.lastTxAt > 0) t.tx.note(now - t.lastTxAt);
      t.lastTxAt = now;
      t.mutationToPatch.note(now - t.earliestMutationAt);
      // N receives collapsed into ONE serialized state → N-1 seq values
      // were overwritten before ever being transmitted (documented
      // Colyseus schema coalescing — the clients' "seq gap" counter).
      if (t.receivesSinceLastPatch > 1) t.coalescedTotal += t.receivesSinceLastPatch - 1;
      t.receivesSinceLastPatch = 0;
    }

    if (now - this.lastSummaryAt >= SUMMARY_INTERVAL_MS) {
      this.lastSummaryAt = now;
      this.logSummary();
    }
  }

  removePlayer(playerId: string): void {
    this.players.delete(playerId);
  }

  /** Compact per-player diag block for the NET_DIAG relay message. */
  buildDiag(): ServerPlayerDiag[] {
    const out: ServerPlayerDiag[] = [];
    for (const [id, t] of this.players) {
      out.push({
        id,
        rxAvgMs: Math.round(t.rx.avgMs),
        rxMaxMs: Math.round(t.rx.maxMs),
        rxLastGapMs: Math.round(t.rx.lastGapMs),
        txAvgMs: Math.round(t.tx.avgMs),
        txMaxMs: Math.round(t.tx.maxMs),
        txLastGapMs: Math.round(t.tx.lastGapMs),
        seqDup: t.seqDup,
        seqBack: t.seqBack,
        seqGapTotal: t.seqGapTotal,
        coalescedTotal: t.coalescedTotal,
      });
    }
    return out;
  }

  private logSummary(): void {
    const patch = this.patchGap.drainSummary();
    console.log(`[NET TRACE ${this.roomId}] patch broadcast: ${formatGapSummary(patch)}`);
    for (const [id, t] of this.players) {
      const rx: GapStatsSummary | null = t.rx.drainSummary();
      const tx: GapStatsSummary | null = t.tx.drainSummary();
      const m2p: GapStatsSummary | null = t.mutationToPatch.drainSummary();
      const cts: GapStatsSummary | null = t.senderClockGap.drainSummary();
      console.log(
        `[NET TRACE ${this.roomId} PLAYER ${id}]\n` +
          `  Server receive:   ${formatGapSummary(rx)}\n` +
          `  Sender clock gap: ${formatGapSummary(cts)}\n` +
          `  Server outbound:  ${formatGapSummary(tx)}\n` +
          `  Mutation→patch:   ${formatGapSummary(m2p)}\n` +
          `  Seq: dup ${t.seqDup}  backwards ${t.seqBack}  gaps ${t.seqGapTotal}  ` +
          `coalesced-by-patch ${t.coalescedTotal}`,
      );
    }
  }
}
