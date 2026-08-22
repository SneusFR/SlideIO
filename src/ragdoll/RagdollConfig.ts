/**
 * Central tuning for the physical ragdoll system (Rapier-simulated
 * skeletons for bots, remote players and corpses).
 * Every ragdoll gameplay/feel value lives here — no magic numbers elsewhere.
 * Units: meters, seconds, radians, m/s (impulses are expressed as velocity
 * deltas, exactly like the existing knockback system).
 */
export const RagdollConfig = {
  // ---- Knockdown trigger ----
  /**
   * A knockback impulse (m/s) at or above this magnitude knocks a LIVING
   * character into a temporary ragdoll. Calibrated against the weapons:
   *   Hammer sweep  ≈ 17.9  → ragdoll
   *   Ground Slam   ≈ 14.8  → ragdoll
   *   Spear rush    ≈ 24.7  → ragdoll
   *   Spear sweep   ≈ 12.6  → NO ragdoll (stays a shove)
   *   Plasma / bullets have no impulse → never a ragdoll
   */
  knockdownImpulseThreshold: 13.5,

  // ---- Temporary (non-lethal) ragdoll ----
  /** The victim stays down at least this long, whatever the physics says. */
  temporaryMinDuration: 0.8,
  /** Hard cap: the victim gets back up even if the body never settles. */
  temporaryMaxDuration: 3.5,
  /** Root (pelvis) linear speed below which the body counts as settled. */
  recoveryLinearVelocity: 2.0,
  /** Root angular speed below which the body counts as settled. */
  recoveryAngularVelocity: 2.5,
  /** Fraction of the pelvis velocity kept by the capsule at recovery. */
  recoveryMomentumRetention: 0.5,

  // ---- Death ragdoll / corpses ----
  /** Full-physics corpse lifetime before the fade starts. */
  corpseLifetime: 5.0,
  /** Very short dissolve at the end (opacity fade — never a hard pop). */
  corpseFadeDuration: 0.45,
  /** Max simultaneous corpses; beyond it the OLDEST fades out early. */
  maxCorpses: 10,

  // ---- Body dynamics ----
  /** Linear damping on every ragdoll body (air drag feel). */
  linearDamping: 0.22,
  /**
   * Strong angular damping: with spherical joints (the Rapier compat JS
   * build exposes no per-joint angular limits) this is what keeps limbs
   * from spinning 720° while preserving the goofy flailing.
   */
  angularDamping: 1.7,
  /**
   * Rapier world gravity is 9.81 but the game's characters fall at
   * MovementConfig.gravity (26). Scale ragdoll gravity toward the game
   * feel — slightly under the exact ratio so bodies read a bit floaty.
   */
  gravityScale: 2.2,
  /** Collider friction — bodies slide a little, then stop. */
  friction: 0.7,
  /** Slight bounce on impact (never rubber balls). */
  restitution: 0.18,

  // ---- Stability safeties ----
  maxLinearVelocity: 45,
  maxAngularVelocity: 26,

  // ---- Impact transfer ----
  /**
   * Extra LOCAL velocity kick applied at the impact point on the hit body
   * (on top of the uniform momentum transfer). Produces the natural body
   * rotation of a hammer BONK without breaking momentum conservation.
   */
  impactSpinBoost: 0.55,
  /** Synthetic impact point offsets (when the hit has no precise point). */
  impactPointUpOffset: 0.25,
  impactPointBackOffset: 0.2,

  // ---- CCD ----
  /** Continuous collision detection on pelvis / torso / head only. */
  ccdOnKeyParts: true,

  // ---- Skeleton masses (kg) — most of the weight in torso + pelvis ----
  mass: {
    pelvis: 14,
    chest: 22,
    head: 6,
    upperArm: 2.5,
    lowerArm: 1.8,
    upperLeg: 8,
    lowerLeg: 5,
  },

  // ---- Debug (dev only — draws colliders + velocity vectors and logs
  // part names/masses at activation). Off by default; enable with the
  // `?ragdollDebug=1` URL parameter (never persisted, never in builds
  // unless explicitly requested).
  debugDraw:
    typeof location !== "undefined" && /[?&]ragdollDebug=1/.test(location.search),
};

export type RagdollConfigType = typeof RagdollConfig;