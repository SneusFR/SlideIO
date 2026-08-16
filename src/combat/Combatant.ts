import * as THREE from "three";
import { KillMethod } from "./KillMethod";
import { HitZone } from "./HitZone";

/**
 * Anything that can fight in the FFA: the human player and every bot.
 * Shared by the damage system, the weapons, the bot AI and the spawner.
 */
export interface Combatant {
  readonly id: number;
  readonly name: string;
  readonly health: Health;
  /**
   * False while this combatant cannot be acquired as a target (e.g. the
   * player burrowed underground during MOLE STRIKE). Undefined = targetable.
   */
  targetable?: boolean;
  /** Current world velocity (read-only usage — for aim prediction / spawn scoring). */
  readonly velocity: THREE.Vector3;
  /** Capsule center position. */
  getPosition(out: THREE.Vector3): THREE.Vector3;
  /** Eye / head position (used for LOS checks and beam origins). */
  getEyePosition(out: THREE.Vector3): THREE.Vector3;
  /**
   * Add a knockback impulse (m/s) ON TOP of the current velocity.
   * Never a teleport, never a velocity reset — the victim keeps its
   * momentum and the shove integrates naturally with the physics.
   */
  applyImpulse(impulse: THREE.Vector3): void;
  /**
   * Optional cosmetic reaction to a confirmed hit from the LOCAL player
   * (damage flash, headshot glint…). Purely visual — never gameplay.
   */
  onHitVisual?(zone: HitZone, position: THREE.Vector3 | null): void;
}

/**
 * Universal health component: HP, death, spawn protection and callbacks.
 * Used identically by the player and every bot — damage is written once.
 */
export class Health {
  current: number;
  alive = true;
  protectionTimer = 0;
  /**
   * Hard invulnerability (killstreak abilities). Blocks applyDamage() but
   * NOT kill() — the kill plane and the suicide key must always work.
   */
  invulnerable = false;

  /** Fired every time damage is actually applied. */
  onDamaged?: (amount: number, attacker: Combatant | null) => void;
  /**
   * Fired EXACTLY ONCE when HP reaches 0 (`alive` flips to false and blocks
   * any further damage, so continuous beams can never produce a second kill
   * event for the same death). Carries the explicit kill method AND the
   * hit zone of the fatal hit (HEAD = headshot kill).
   */
  onDeath?: (attacker: Combatant | null, method: KillMethod, hitZone: HitZone) => void;

  /**
   * Additional pure OBSERVERS (match stats, future systems…). They run after
   * the primary gameplay callbacks and can never replace or block them —
   * several systems can watch the same Health without clobbering each other.
   */
  private readonly damageListeners: ((amount: number, attacker: Combatant | null) => void)[] = [];
  private readonly deathListeners: ((
    attacker: Combatant | null,
    method: KillMethod,
    hitZone: HitZone,
  ) => void)[] = [];

  /** Observe every applied damage tick (never called on blocked damage). */
  addDamageListener(fn: (amount: number, attacker: Combatant | null) => void): void {
    this.damageListeners.push(fn);
  }

  /** Observe the single death event (same guarantees as `onDeath`). */
  addDeathListener(
    fn: (attacker: Combatant | null, method: KillMethod, hitZone: HitZone) => void,
  ): void {
    this.deathListeners.push(fn);
  }

  constructor(readonly max: number) {
    this.current = max;
  }

  get ratio(): number {
    return Math.max(0, this.current / this.max);
  }

  get protected(): boolean {
    return this.protectionTimer > 0;
  }

  /**
   * Apply damage from `attacker` (null = environment).
   * No friendly-fire logic needed: FFA — but owners never damage themselves
   * because weapons skip their own combatant during the raycast.
   */
  applyDamage(
    amount: number,
    attacker: Combatant | null,
    method: KillMethod = KillMethod.ENVIRONMENT,
    hitZone: HitZone = HitZone.BODY,
  ): boolean {
    if (!this.alive || this.invulnerable || this.protectionTimer > 0 || amount <= 0) return false;
    this.current -= amount;
    this.onDamaged?.(amount, attacker);
    for (const fn of this.damageListeners) fn(amount, attacker);
    if (this.current <= 0) {
      this.current = 0;
      this.alive = false;
      this.onDeath?.(attacker, method, hitZone);
      for (const fn of this.deathListeners) fn(attacker, method, hitZone);
    }
    return true;
  }

  /** Instantly kill (kill plane, suicide key…). */
  kill(attacker: Combatant | null): void {
    if (!this.alive) return;
    this.current = 0;
    this.alive = false;
    this.onDeath?.(attacker, KillMethod.ENVIRONMENT, HitZone.BODY);
    for (const fn of this.deathListeners) fn(attacker, KillMethod.ENVIRONMENT, HitZone.BODY);
  }

  update(dt: number): void {
    if (this.protectionTimer > 0) {
      this.protectionTimer = Math.max(0, this.protectionTimer - dt);
    }
  }

  /** Restore to full HP with a short spawn protection window. */
  reset(protectionDuration: number): void {
    this.current = this.max;
    this.alive = true;
    this.protectionTimer = protectionDuration;
    this.invulnerable = false;
  }
}