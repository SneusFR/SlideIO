/** Outcome of one applyDamage() call (server-side, event-driven). */
export interface DamageResult {
  /** True when HP was actually reduced. */
  applied: boolean;
  /** Damage actually dealt after clamping (0 when refused). */
  damageDealt: number;
  /** True when this damage killed the target (fires exactly once). */
  victimDied: boolean;
  /** Why the damage was refused (undefined when applied). */
  refusedReason?:
    | "target_not_found"
    | "target_dead"
    | "attacker_not_found"
    | "attacker_dead"
    | "invalid_amount"
    | "spawn_protected";
}