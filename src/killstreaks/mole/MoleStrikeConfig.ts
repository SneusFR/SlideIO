/**
 * MOLE STRIKE killstreak tuning.
 * Every gameplay-feel value lives here — no magic numbers elsewhere.
 * Units: meters, seconds, radians.
 */
export const MoleStrikeConfig = {
  // ---- Charge requirement ----
  /** Kills WITHOUT DYING required to arm the killstreak. */
  moleStrikeRequiredKills: 5,

  // ---- Underground phase ----
  /** Maximum time spent underground before the auto-emerge (s). */
  moleStrikeDuration: 5.0,
  /** Horizontal burrowing speed while underground (m/s). */
  moleStrikeUndergroundSpeed: 11,
  /** Time of the dive-in transition (camera sinks, dirt bursts) (s). */
  moleStrikeEnterDuration: 0.45,
  /** Time of the emerge transition (camera pops back up) (s). */
  moleStrikeExitDuration: 0.35,
  /** Upward velocity applied at emergence (dramatic pop-out) (m/s). */
  moleStrikeExitUpwardBoost: 7,
  /** How far the camera sinks while underground (m). Eye ends ≈ ground level. */
  moleStrikeCameraDrop: 1.25,
  /** Continuous tiny camera rumble while burrowing (shake per second). */
  moleStrikeRumbleShakePerSecond: 0.55,

  // ---- Activation precondition ----
  /**
   * Solid ground must exist within this distance BELOW THE FEET for the
   * dive to start (no burrowing into the void from mid-air).
   */
  moleStrikeGroundProximity: 2.5,

  // ---- Emergence AoE ----
  /** Damage radius around the emergence point (m). */
  moleStrikeRadius: 7,
  /** Damage as a fraction of each victim's MAX health. */
  moleStrikeDamageFraction: 0.75,
  /** Vertical band around the emergence point that can be hit (m). */
  moleStrikeHeightTolerance: 3.5,
  /** Horizontal radial knockback applied to each victim (m/s). */
  moleStrikeKnockback: 16,
  /** Vertical pop-up added to each victim (m/s). */
  moleStrikeVerticalKnockback: 6,
  /** Camera shake at the emergence blast. */
  moleStrikeEmergeCameraShake: 1.0,

  // ---- Dirt trail VFX ----
  /** Dirt particles per second while burrowing. */
  moleStrikeTrailParticleRate: 80,
  /** Fullscreen dirt overlay opacity while fully underground (0..1). */
  moleStrikeOverlayOpacity: 0.45,

  // ---- Colors (hex) — bright tans/oranges: additive particles dim browns ----
  moleStrikeDirtColor: 0xc9a26b,
  moleStrikeDirtDarkColor: 0x8a5a2b,
  moleStrikeBlastColor: 0xd97706,
  moleStrikeFlashColor: 0xfcd9a0,
};

export type MoleStrikeConfigType = typeof MoleStrikeConfig;