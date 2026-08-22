import type { NetworkPlayerInfo } from "./MultiplayerClient";
import { PlayerMatchStats, getKDRatio } from "../stats/MatchStatsManager";

/**
 * MULTIPLAYER leaderboard source (Phase 4).
 *
 * In LOCAL mode the leaderboard is fed by the MatchStatsManager (player +
 * bots). In MULTIPLAYER the SERVER owns K/D/A — this adapter converts
 * `room.state.players` into the exact `PlayerMatchStats[]` shape the
 * existing LeaderboardHUD renders, so the UI is never duplicated.
 *
 * Guarantees:
 *  - EVERY player currently in the room appears (0/0/0 from the start,
 *    host included with zero ranking priority);
 *  - identical data on every client (it is a pure projection of the
 *    synchronized server state);
 *  - the local highlight is decided by sessionId — never by name;
 *  - players who leave simply disappear (server removed them).
 */
export class NetworkStatsSource {
  /**
   * Stable numeric row ids for the DOM reconciliation in LeaderboardHUD
   * (which is keyed by `combatantId`). Offset far above any local
   * combatant id so switching modes can never reuse a stale row.
   */
  private readonly numericIds = new Map<string, number>();
  private nextId = 1000;
  /** Cheap change signature — the HUD only re-renders on real changes. */
  private lastSignature = "";

  /**
   * Project the network players into sorted leaderboard stats.
   * Returns null when NOTHING relevant changed since the last call
   * (so callers can poll every frame without re-rendering the DOM).
   */
  build(players: NetworkPlayerInfo[], localSessionId: string | null): PlayerMatchStats[] | null {
    // Ping is BUCKETED (5 ms) in the signature so tiny RTT wobble never
    // triggers a DOM re-render every second.
    const signature = players
      .map(
        (p) =>
          `${p.id}:${p.name}:${p.kills}/${p.deaths}/${p.assists}:${Math.round(p.pingMs / 5)}`,
      )
      .sort()
      .join("|");
    if (signature === this.lastSignature) return null;
    this.lastSignature = signature;

    // Drop numeric ids of players who left (their rows are removed too).
    const present = new Set(players.map((p) => p.id));
    for (const key of [...this.numericIds.keys()]) {
      if (!present.has(key)) this.numericIds.delete(key);
    }

    const stats: PlayerMatchStats[] = players.map((p) => ({
      combatantId: this.idFor(p.id),
      displayName: p.name,
      isLocalPlayer: p.id === localSessionId, // sessionId — NEVER the name
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      pingMs: p.pingMs,
    }));

    // EXACT same ranking rules as the local MatchStatsManager:
    // kills DESC → deaths ASC → assists DESC → K/D DESC → stable id.
    stats.sort((a, b) => {
      if (b.kills !== a.kills) return b.kills - a.kills;
      if (a.deaths !== b.deaths) return a.deaths - b.deaths;
      if (b.assists !== a.assists) return b.assists - a.assists;
      const kd = getKDRatio(b) - getKDRatio(a);
      if (kd !== 0) return kd;
      return a.combatantId - b.combatantId;
    });
    return stats;
  }

  private idFor(sessionId: string): number {
    let id = this.numericIds.get(sessionId);
    if (id === undefined) {
      id = this.nextId++;
      this.numericIds.set(sessionId, id);
    }
    return id;
  }
}