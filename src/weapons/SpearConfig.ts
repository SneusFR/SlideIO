/**
 * Central tuning for the Astral Lance (melee spear).
 * Every gameplay/feel value for the spear lives here — no magic numbers elsewhere.
 * Units: meters, seconds, radians (unless noted), fractions of max HP.
 */
export const SpearConfig = {
  // ---- Input: quick press vs held press (LMB-style tap/hold on the melee key) ----
  /** Held longer than this → CHARGED RUSH. Released before → SWEEP. */
  spearChargeHoldThreshold: 0.3,

  // ---- Normal attack: wide horizontal sweep (to the LEFT) ----
  /** Damage = fraction of the TARGET's max HP (independent from the rush). */
  spearSweepDamageFraction: 0.35,
  spearSweepRange: 4.5, // longer reach than the hammer (it's a spear)
  spearSweepArcDegrees: 140, // total horizontal arc in front of the player
  spearSweepHeight: 1.9, // vertical tolerance around eye height (m)
  spearSweepDuration: 0.7, // wind-up → sweep → follow-through → recovery
  spearSweepHitStart: 0.16, // hit window opens (s into the sweep)
  spearSweepHitEnd: 0.4, // hit window closes (s into the sweep)
  spearSweepKnockback: 12, // horizontal impulse on hit (m/s)
  spearSweepVerticalKnockback: 4, // small pop-up so the knockback reads well
  spearSweepVelocityInheritance: 0.25, // fraction of attacker velocity added

  // ---- Charged attack: SPEAR RUSH (forward charge, tip-first) ----
  /** Reference is the NORMAL RUN SPEED — never an arbitrary number. */
  spearRushSpeedMultiplier: 2.0,
  spearRushMaxDuration: 5.0, // automatic stop even with no obstacle
  spearRushCooldown: 5.0, // starts when the rush ENDS (any reason)
  /** A successful rush hit removes exactly this fraction of the target's max HP. */
  spearRushDamageFraction: 0.5,

  spearRushKnockback: 24, // impulse along the charge direction (m/s)
  spearRushVerticalKnockback: 6, // small vertical component on impact

  /** Very light steering during the rush (rad/s) — no instant 180° turns. */
  spearRushSteering: 1.2,
  /** Fraction of the rush speed kept when the rush ends (no hard reset). */
  spearRushMomentumRetention: 0.55,
  /** Gravity multiplier while rushing airborne (short anti-nosedive, not flight). */
  spearAirRushGravityScale: 0.15,
  /** Max |vertical| component of the charge direction (prevents rocket launches). */
  spearRushMaxVerticalComponent: 0.35,

  // ---- Tip collision (the dangerous part is the TIP, not the player capsule) ----
  /** How far ahead of the eyes the spear tip reaches during the rush. */
  spearTipReach: 2.4,
  /** Radius around the tip's swept segment that counts as a hit. */
  spearRushHitRadius: 1.1,
  /** If the velocity along the charge drops below this fraction → wall stop. */
  spearRushMinSpeedFraction: 0.35,

  // ---- Camera feedback ----
  spearSweepCameraShake: 0.1, // small shake when the sweep starts
  spearHitCameraShake: 0.45, // shake when the sweep connects
  spearRushStartCameraShake: 0.25, // impulse when the charge launches
  spearRushHitCameraShake: 0.85, // big shake on a successful rush impact
  /** Fraction of the dash FOV boost applied during the rush (speed feel). */
  spearRushFovKick: 0.75,
};

export type SpearConfigType = typeof SpearConfig;