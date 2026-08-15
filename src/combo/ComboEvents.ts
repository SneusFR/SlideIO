import { Combatant } from "../combat/Combatant";
import { KillMethod } from "../combat/KillMethod";

/**
 * Clean kill event consumed by the combo/medal systems.
 * Emitted EXACTLY ONCE per death by the damage system (Health.onDeath),
 * never derived from per-frame HP observation.
 */
export interface KillEvent {
  killer: Combatant | null;
  victim: Combatant;
  method: KillMethod;
}

/** Why a combo ended (both cases hard-reset the combo state). */
export type ComboEndReason = "timeout" | "death";