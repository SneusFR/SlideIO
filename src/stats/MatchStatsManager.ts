import { Combatant } from "../combat/Combatant";

/** Tunables for the assist attribution rules. */
export const MatchStatsConfig = {
  /** Damage older than this (seconds, game time) never grants an assist. */
  assistWindow: 8.0,
  /** Minimum contribution as a fraction of the victim's MAX HP (0.15 = 15%). */
  assistMinDamageFraction: 0.15,
};

/** Per-participant FFA match statistics (source of truth for the HUD). */
export interface PlayerMatchStats {
  combatantId: number;
  displayName: string;
  isLocalPlayer: boolean;

  kills: number;
  deaths: number;
  assists: number;

  /** MULTIPLAYER only: smoothed RTT (ms) shown left of the name in the
   *  leaderboard. Undefined in local mode (bots have no ping). */
  pingMs?: number;
}

/** Safe K/D — never Infinity/NaN (deaths clamped to at least 1). */
export function getKDRatio(stats: PlayerMatchStats): number {
  return stats.kills / Math.max(1, stats.deaths);
}

/** One attacker's running contribution to a victim's CURRENT life. */
interface DamageContribution {
  attackerId: number;
  damageAmount: number;
  lastDamageTime: number;
}

/**
 * FFA match statistics: kills / deaths / assists for EVERY participant
 * (local player + bots), fed exclusively by combat events. Pure data —
 * it never touches gameplay and never writes to the DOM. The HUD (or a
 * future full scoreboard / server feed) observes `onStatsChanged`.
 *
 * Kill attribution reuses the existing single-death guarantee of Health:
 * the combatant landing the final blow gets the kill; everyone else who
 * contributed significant recent damage gets an assist.
 */
export class MatchStatsManager {
  /** Fired on every meaningful change: kill, death, assist, join, leave. */
  onStatsChanged: (() => void) | null = null;

  private readonly stats = new Map<number, PlayerMatchStats>();
  /** victimId → (attackerId → contribution), for the victim's CURRENT life. */
  private readonly damageContributors = new Map<number, Map<number, DamageContribution>>();
  /** Game-time clock (seconds) — paused with the game, fed by Game. */
  private now = 0;

  /** Advance the internal clock (call once per frame with elapsed game time). */
  setTime(time: number): void {
    this.now = time;
  }

  /**
   * Register a participant and start observing its combat events.
   * Safe to call for bots added mid-match (they join with 0/0/0).
   */
  register(combatant: Combatant, displayName: string, isLocalPlayer = false): void {
    if (this.stats.has(combatant.id)) return;
    this.stats.set(combatant.id, {
      combatantId: combatant.id,
      displayName,
      isLocalPlayer,
      kills: 0,
      deaths: 0,
      assists: 0,
    });
    // Pure observation — the gameplay callbacks (onDamaged/onDeath) are untouched.
    combatant.health.addDamageListener((amount, attacker) =>
      this.recordDamage(combatant, attacker, amount),
    );
    combatant.health.addDeathListener((killer) => this.recordDeath(combatant, killer));
    this.emit();
  }

  /**
   * A participant left the match (bot removed from the Escape menu).
   * NOT a death: no stat changes for anyone, the row simply disappears.
   */
  unregister(combatantId: number): void {
    if (!this.stats.delete(combatantId)) return;
    this.damageContributors.delete(combatantId);
    // Scrub its pending contributions so it can never earn a ghost assist.
    for (const contributors of this.damageContributors.values()) {
      contributors.delete(combatantId);
    }
    this.emit();
  }

  /** Fresh match: everyone back to 0/0/0 (never called on respawn). */
  resetAll(): void {
    for (const s of this.stats.values()) {
      s.kills = 0;
      s.deaths = 0;
      s.assists = 0;
    }
    this.damageContributors.clear();
    this.emit();
  }

  /**
   * Participants ranked for the leaderboard:
   *   kills DESC → deaths ASC → assists DESC → K/D DESC → stable id.
   */
  getSortedStats(): PlayerMatchStats[] {
    const list = [...this.stats.values()];
    list.sort((a, b) => {
      if (b.kills !== a.kills) return b.kills - a.kills;
      if (a.deaths !== b.deaths) return a.deaths - b.deaths;
      if (b.assists !== a.assists) return b.assists - a.assists;
      const kd = getKDRatio(b) - getKDRatio(a);
      if (kd !== 0) return kd;
      return a.combatantId - b.combatantId;
    });
    return list;
  }

  // ---- Combat event recording -------------------------------------------

  /** Accumulate damage against the victim's current life (assist bookkeeping). */
  private recordDamage(victim: Combatant, attacker: Combatant | null, amount: number): void {
    if (!attacker || attacker === victim) return; // environment / self: no assist credit
    let contributors = this.damageContributors.get(victim.id);
    if (!contributors) {
      contributors = new Map();
      this.damageContributors.set(victim.id, contributors);
    }
    const entry = contributors.get(attacker.id);
    if (entry) {
      entry.damageAmount += amount;
      entry.lastDamageTime = this.now;
    } else {
      contributors.set(attacker.id, {
        attackerId: attacker.id,
        damageAmount: amount,
        lastDamageTime: this.now,
      });
    }
    // Damage alone never reorders the leaderboard → no emit here.
  }

  /**
   * A real combat death (fires exactly once per death, respawns excluded):
   *   victim  → deaths +1
   *   killer  → kills  +1 (final blow, never also an assist)
   *   others  → assist  if recent + significant contribution
   */
  private recordDeath(victim: Combatant, killer: Combatant | null): void {
    const victimStats = this.stats.get(victim.id);
    if (!victimStats) return;

    victimStats.deaths += 1;

    const killerId = killer && killer.id !== victim.id ? killer.id : null;
    if (killerId !== null) {
      const killerStats = this.stats.get(killerId);
      if (killerStats) killerStats.kills += 1;
    }

    // Assists: significant recent contributors, excluding the killer.
    const contributors = this.damageContributors.get(victim.id);
    if (contributors) {
      const minDamage = MatchStatsConfig.assistMinDamageFraction * victim.health.max;
      for (const c of contributors.values()) {
        if (c.attackerId === killerId) continue;
        if (this.now - c.lastDamageTime > MatchStatsConfig.assistWindow) continue;
        if (c.damageAmount < minDamage) continue;
        const s = this.stats.get(c.attackerId);
        if (s) s.assists += 1;
      }
      // Previous life must NEVER influence the next one.
      this.damageContributors.delete(victim.id);
    }

    this.emit();
  }

  private emit(): void {
    this.onStatsChanged?.();
  }
}