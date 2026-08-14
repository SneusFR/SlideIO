import * as THREE from "three";

/**
 * Anything that can fight in the FFA: the human player and every bot.
 * Shared by the damage system, the weapons, the bot AI and the spawner.
 */
export interface Combatant {
  readonly id: number;
  readonly name: string;
  readonly health: Health;
  /** Current world velocity (read-only usage — for aim prediction / spawn scoring). */
  readonly velocity: THREE.Vector3;
  /** Capsule center position. */
  getPosition(out: THREE.Vector3): THREE.Vector3;
  /** Eye / head position (used for LOS checks and beam origins). */
  getEyePosition(out: THREE.Vector3): THREE.Vector3;
}

/**
 * Universal health component: HP, death, spawn protection and callbacks.
 * Used identically by the player and every bot — damage is written once.
 */
export class Health {
  current: number;
  alive = true;
  protectionTimer = 0;

  /** Fired every time damage is actually applied. */
  onDamaged?: (amount: number, attacker: Combatant | null) => void;
  /** Fired once when HP reaches 0. */
  onDeath?: (attacker: Combatant | null) => void;

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
  applyDamage(amount: number, attacker: Combatant | null): boolean {
    if (!this.alive || this.protectionTimer > 0 || amount <= 0) return false;
    this.current -= amount;
    this.onDamaged?.(amount, attacker);
    if (this.current <= 0) {
      this.current = 0;
      this.alive = false;
      this.onDeath?.(attacker);
    }
    return true;
  }

  /** Instantly kill (kill plane, suicide key…). */
  kill(attacker: Combatant | null): void {
    if (!this.alive) return;
    this.current = 0;
    this.alive = false;
    this.onDeath?.(attacker);
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
  }
}