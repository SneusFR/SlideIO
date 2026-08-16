import { serverConfig } from "../config/serverConfig";
import { GameRoomState } from "../schemas/GameRoomState";
import { NetworkPlayer } from "../schemas/NetworkPlayer";
import { AssistTracker } from "./AssistTracker";
import { DamageResult } from "./DamageResult";
import { DamageType, HitZone } from "./DamageTypes";

/** Generic damage request — EVERY future weapon goes through this. */
export interface DamageRequest {
  /** Attacker sessionId, or null for environment damage. */
  attackerId: string | null;
  targetId: string;
  amount: number;
  damageType: DamageType;
  hitZone: HitZone;
}

/** Payload of the single PLAYER_DIED event per death. */
export interface PlayerDiedEvent {
  victimId: string;
  killerId: string | null;
  assistIds: string[];
  damageType: DamageType;
  hitZone: HitZone;
  /** Prepared for the headshot phase — always false in Phase 4. */
  isHeadshot: boolean;
  /** Server ms of the scheduled respawn. */
  respawnAt: number;
}

/**
 * Server authority over the combat state (Phase 4).
 *
 * SINGLE damage pipeline — never duplicated per weapon:
 *
 *   weapon / debug tool
 *   → applyDamage()          (validate attacker / target / amount / protection)
 *   → HP clamp (never < 0)
 *   → assist bookkeeping
 *   → handleDeath() once     (K/D/A, PLAYER_DIED event)
 *
 * All HP/stat fields live on the synchronized NetworkPlayer schema, so a
 * damage event is the ONLY thing that triggers network traffic — nothing
 * here runs per frame.
 */
export class CombatManager {
  private readonly assists = new AssistTracker();
  /** sessionId → server ms until which the player is spawn-protected. */
  private readonly spawnProtectionUntil = new Map<string, number>();

  /** Fired exactly once per validated death (GameRoom broadcasts + respawns). */
  onPlayerDied: ((event: PlayerDiedEvent) => void) | null = null;

  constructor(private readonly state: GameRoomState) {}

  /** Full combat reset at match start / respawn: HP, alive, protection. */
  initializePlayerForMatch(player: NetworkPlayer): void {
    player.maxHealth = serverConfig.playerMaxHealth;
    player.health = serverConfig.playerMaxHealth;
    player.isAlive = true;
    player.respawnAt = 0;
    this.grantSpawnProtection(player.id, serverConfig.respawnInvulnerability);
  }

  /** True while the player's (re)spawn protection window is active. */
  isSpawnProtected(playerId: string): boolean {
    return (this.spawnProtectionUntil.get(playerId) ?? 0) > Date.now();
  }

  grantSpawnProtection(playerId: string, seconds: number): void {
    this.spawnProtectionUntil.set(playerId, Date.now() + seconds * 1000);
  }

  /**
   * THE generic damage entry point. Refusals are silent and side-effect
   * free (a dead target / protected target never re-dies or re-counts).
   */
  applyDamage(request: DamageRequest): DamageResult {
    const target = this.state.players.get(request.targetId);
    if (!target) return refused("target_not_found");
    // No double death: a beam still active on a corpse deals NOTHING.
    if (!target.isAlive) return refused("target_dead");

    let attacker: NetworkPlayer | null = null;
    if (request.attackerId !== null) {
      attacker = this.state.players.get(request.attackerId) ?? null;
      if (!attacker) return refused("attacker_not_found");
      if (!attacker.isAlive) return refused("attacker_dead");
    }

    const amount = sanitizeAmount(request.amount);
    if (amount === null) return refused("invalid_amount");

    // Spawn protection is refused HERE (never simulated with huge HP).
    if (this.isSpawnProtected(target.id)) return refused("spawn_protected");

    // Clamp: HP never goes below 0.
    const dealt = Math.min(amount, target.health);
    target.health -= dealt;

    if (attacker && attacker.id !== target.id) {
      this.assists.recordDamage(target.id, attacker.id, dealt, Date.now());
    }

    if (target.health <= 0) {
      target.health = 0;
      this.handleDeath(target, attacker, request.damageType, request.hitZone);
      return { applied: true, damageDealt: dealt, victimDied: true };
    }
    return { applied: true, damageDealt: dealt, victimDied: false };
  }

  /** Restore a respawning player and clear stale damage contributions. */
  handleRespawn(player: NetworkPlayer): void {
    player.health = player.maxHealth;
    player.isAlive = true;
    player.respawnAt = 0;
    this.grantSpawnProtection(player.id, serverConfig.respawnInvulnerability);
    // A fresh life owes nothing to the previous one.
    this.assists.clearVictim(player.id);
  }

  /** Disconnect cleanup: contributions + protection state. */
  removePlayer(playerId: string): void {
    this.assists.removeParticipant(playerId);
    this.spawnProtectionUntil.delete(playerId);
  }

  // ------------------------------------------------------------------

  /** Runs EXACTLY once per death (guarded by the isAlive check above). */
  private handleDeath(
    victim: NetworkPlayer,
    killer: NetworkPlayer | null,
    damageType: DamageType,
    hitZone: HitZone,
  ): void {
    victim.isAlive = false;
    victim.deaths += 1;
    victim.respawnAt = Date.now() + serverConfig.respawnDelay * 1000;

    const killerId = killer && killer.id !== victim.id ? killer.id : null;
    if (killerId) killer!.kills += 1; // never a kill for a suicide

    // Assists: recent + significant contributors, killer/victim excluded.
    const assistIds = this.assists.collectAssists(
      victim.id,
      killerId,
      victim.maxHealth,
      Date.now(),
    );
    for (const id of assistIds) {
      const contributor = this.state.players.get(id);
      if (contributor) contributor.assists += 1;
    }
    this.assists.clearVictim(victim.id);

    this.onPlayerDied?.({
      victimId: victim.id,
      killerId,
      assistIds,
      damageType,
      hitZone,
      // Phase 5: the zone comes from SERVER hit detection (WeaponManager),
      // so a HEAD kill is a real, validated headshot.
      isHeadshot: hitZone === HitZone.HEAD,
      respawnAt: victim.respawnAt,
    });
  }
}

function refused(reason: NonNullable<DamageResult["refusedReason"]>): DamageResult {
  return { applied: false, damageDealt: 0, victimDied: false, refusedReason: reason };
}

/** Strictly positive finite damage, clamped to the sanity cap. */
function sanitizeAmount(raw: number): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.min(raw, serverConfig.maxSingleDamage);
}