/**
 * Central tuning for the combat hammer (melee).
 * Every gameplay/feel value for the hammer lives here — no magic numbers elsewhere.
 * Units: meters, seconds, radians (unless noted), fractions of max HP.
 */
export const HammerConfig = {
  // ---- WHIRLWIND (A while grounded) — Brick Maul r5 ----
  /** FLAT damage per victim for the WHOLE attack (never a max-HP fraction). */
  hammerGroundDamage: 50,
  hammerSwingRange: 3.4, // reach of the melee zone (m)
  hammerSwingArcDegrees: 360, // full circle: three visual turns around the player
  hammerSwingHeight: 1.9, // vertical tolerance around eye height (m)
  hammerSwingDuration: 1.35, // full Whirlwind clip: wind-up → 3 turns → recovery
  hammerHitStart: 0.2, // active phase opens (s into the attack)
  hammerHitEnd: 1.04, // active phase closes (s into the attack)
  hammerGroundKnockback: 17, // horizontal impulse on hit (m/s)
  hammerGroundVerticalKnockback: 5.5, // small pop-up so the knockback reads well
  hammerVelocityInheritance: 0.25, // fraction of attacker velocity added to the impulse

  // ---- Ground slam (A while airborne) ----
  /** FLAT damage per victim at the single AoE impact. */
  groundSlamDamage: 50,
  groundSlamSpeed: 40, // downward charge speed (m/s) — fast but not a teleport
  /**
   * Physical hang before the dive (s). ZERO: the descent starts the very
   * frame LMB is pressed — the 0.20 s Slam_Start clip is a purely visual
   * anticipation played WHILE already diving (never a gameplay delay).
   */
  groundSlamWindup: 0,
  groundSlamHorizontalRetention: 0.25, // horizontal momentum kept when the dive starts
  groundSlamAirControl: 0.12, // air-control multiplier during the dive (mostly vertical)
  groundSlamLandingSpeedScale: 0.3, // horizontal speed kept on impact (weighty landing)
  groundSlamRadius: 6, // AoE radius around the impact point (m)
  groundSlamHeightTolerance: 3.0, // vertical band around the impact considered inside
  groundSlamKnockback: 13, // radial impulse away from the impact (m/s)
  groundSlamVerticalKnockback: 7, // shockwave pop-up (m/s)
  groundSlamRecovery: 0.72, // Slam_Land recovery after the REAL contact (melee + firing lockout)

  // ---- Camera feedback ----
  hammerSwingCameraShake: 0.12, // small shake when the swing starts
  hammerCameraShake: 0.5, // shake when a swing connects
  groundSlamCameraShake: 0.95, // big shake at slam impact
  groundSlamFovKick: 0.7, // fraction of the dash FOV boost applied during the dive
};

export type HammerConfigType = typeof HammerConfig;