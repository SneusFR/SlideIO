/**
 * Central tuning for the hit-feedback system (hitmarker, hit sounds,
 * victim flashes, impact particles) and the headshot rules.
 * All timings in seconds — no magic numbers scattered across components.
 */
export const HitFeedbackConfig = {
  // ---- Hitmarker (crosshair pulse) ----
  /** Body hitmarker lifetime — quick, subtle confirmation. */
  bodyHitmarkerDuration: 0.16,
  /** Headshot hitmarker lifetime — longer, clearly more intense. */
  headshotHitmarkerDuration: 0.28,

  // ---- Feedback pulse throttling (continuous beams must never spam) ----
  /** Min interval between two body-hit pulses (marker + sound). */
  bodyHitFeedbackInterval: 0.12,
  /** Min interval between two headshot pulses (marker + sound). */
  headshotHitFeedbackInterval: 0.12,
  /** The Obliterreur AoE ticks slower — calmer aggregated pulse rate. */
  obliterreurFeedbackInterval: 0.25,
  /** Min interval between two victim-side visual reactions per target. */
  targetVisualInterval: 0.12,

  // ---- Victim visual reaction ----
  /** Body-flash decay speed (amount lost per second, body zone). */
  bodyHitFlashDecay: 5,
  /** Head-flash decay speed (amount lost per second, head zone). */
  headHitFlashDecay: 6,

  // ---- Impact particles at the hit point ----
  bodyBurstCount: 4,
  bodyBurstSpeed: 2.5,
  bodyBurstLife: 0.25,
  headBurstCount: 9,
  headBurstSpeed: 4,
  headBurstLife: 0.35,
} as const;