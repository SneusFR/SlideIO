import { serverConfig } from "../config/serverConfig";

/** One attacker's recent damage contribution against one victim. */
interface Contribution {
  damage: number;
  /** Server ms of the LAST damage tick from this attacker. */
  lastDamageTime: number;
}

/**
 * Tracks recent damage contributors per victim so the server can credit
 * assists on death (same spirit as the local bot assist rule):
 *
 *   contributed damage within the assist window
 *   + contribution >= assistMinDamageFraction * victim maxHealth
 *   + contributor is neither the killer nor the victim
 *
 * All bookkeeping is event-driven — nothing runs per frame.
 */
export class AssistTracker {
  /** victimId → (attackerId → contribution). */
  private readonly contributors = new Map<string, Map<string, Contribution>>();

  /** Record an APPLIED damage tick (never call for refused damage). */
  recordDamage(victimId: string, attackerId: string, amount: number, now: number): void {
    if (attackerId === victimId) return; // self-damage never earns assists
    let victimMap = this.contributors.get(victimId);
    if (!victimMap) {
      victimMap = new Map();
      this.contributors.set(victimId, victimMap);
    }
    const entry = victimMap.get(attackerId);
    if (entry && now - entry.lastDamageTime <= serverConfig.assistWindowSeconds * 1000) {
      entry.damage += amount;
      entry.lastDamageTime = now;
    } else {
      // Expired (or first) contribution: restart from this hit.
      victimMap.set(attackerId, { damage: amount, lastDamageTime: now });
    }
  }

  /**
   * Assist ids for a validated death. The killer and the victim are always
   * excluded. Contributions must be recent AND significant.
   */
  collectAssists(
    victimId: string,
    killerId: string | null,
    victimMaxHealth: number,
    now: number,
  ): string[] {
    const victimMap = this.contributors.get(victimId);
    if (!victimMap) return [];
    const minDamage = victimMaxHealth * serverConfig.assistMinDamageFraction;
    const windowMs = serverConfig.assistWindowSeconds * 1000;
    const assists: string[] = [];
    victimMap.forEach((entry, attackerId) => {
      if (attackerId === killerId || attackerId === victimId) return;
      if (now - entry.lastDamageTime > windowMs) return;
      if (entry.damage < minDamage) return;
      assists.push(attackerId);
    });
    return assists;
  }

  /** Drop all contributions against a victim (death / respawn). */
  clearVictim(victimId: string): void {
    this.contributors.delete(victimId);
  }

  /** Full cleanup of a leaving player: as victim AND as contributor. */
  removeParticipant(playerId: string): void {
    this.contributors.delete(playerId);
    this.contributors.forEach((victimMap) => victimMap.delete(playerId));
  }
}