/**
 * Central tuning for the combat hammer (melee).
 * Every gameplay/feel value for the hammer lives here — no magic numbers elsewhere.
 * Units: meters, seconds, radians (unless noted), fractions of max HP.
 */
export const HammerConfig = {
  // ---- Ground swing (A while grounded) ----
  /** Damage = fraction of the TARGET's max HP (stays coherent if HP change). */
  hammerGroundDamageFraction: 0.5,
  hammerSwingRange: 3.4, // reach of the melee zone (m)
  hammerSwingArcDegrees: 120, // total horizontal arc in front of the player
  hammerSwingHeight: 1.9, // vertical tolerance around eye height (m)
  hammerSwingDuration: 0.62, // full animation: wind-up → swing → follow → recovery
  hammerHitStart: 0.18, // hit window opens (s into the swing)
  hammerHitEnd: 0.36, // hit window closes (s into the swing)
  hammerGroundKnockback: 17, // horizontal impulse on hit (m/s)
  hammerGroundVerticalKnockback: 5.5, // small pop-up so the knockback reads well
  hammerVelocityInheritance: 0.25, // fraction of attacker velocity added to the impulse

  // ---- Ground slam (A while airborne) ----
  groundSlamDamageFraction: 0.5, // fraction of the TARGET's max HP per victim
  groundSlamSpeed: 40, // downward charge speed (m/s) — fast but not a teleport
  groundSlamWindup: 0.12, // brief hang before the dive starts
  groundSlamHorizontalRetention: 0.25, // horizontal momentum kept when the dive starts
  groundSlamAirControl: 0.12, // air-control multiplier during the dive (mostly vertical)
  groundSlamLandingSpeedScale: 0.3, // horizontal speed kept on impact (weighty landing)
  groundSlamRadius: 6, // AoE radius around the impact point (m)
  groundSlamHeightTolerance: 3.0, // vertical band around the impact considered inside
  groundSlamKnockback: 13, // radial impulse away from the impact (m/s)
  groundSlamVerticalKnockback: 7, // shockwave pop-up (m/s)
  groundSlamRecovery: 0.35, // short lockout after the impact (melee + firing)

  // ---- Camera feedback ----
  hammerSwingCameraShake: 0.12, // small shake when the swing starts
  hammerCameraShake: 0.5, // shake when a swing connects
  groundSlamCameraShake: 0.95, // big shake at slam impact
  groundSlamFovKick: 0.7, // fraction of the dash FOV boost applied during the dive
};

export type HammerConfigType = typeof HammerConfig;