/**
 * Central weapon tuning for the Plasma Rifle.
 * Every gameplay/visual value for the weapon lives here — no magic numbers elsewhere.
 * Units: meters, seconds, heat units.
 */
export const WeaponConfig = {
  // ---- Damage ----
  plasmaDamagePerSecond: 55,

  // ---- Heat / overheat ----
  maxHeat: 100,
  heatPerSecond: 26, // heat gained per second while firing
  coolingPerSecond: 34, // heat lost per second while not firing
  overheatCoolingPerSecond: 26, // (slower) cooling rate during forced overheat cooldown
  overheatRecoveryThreshold: 35, // heat must fall below this before the weapon re-arms
  overheatMinLockTime: 1.0, // minimum forced lockout after an overheat, seconds

  // ---- Beam ----
  beamRange: 160,
  beamCoreRadius: 0.035,
  beamHaloRadius: 0.11,
  beamCoreColor: 0xe9d5ff,
  beamHaloColor: 0x9333ea,
  beamFlickerSpeed: 42, // Hz-ish flicker of the beam radius

  // ---- Particles ----
  particleRate: 70, // muzzle sparks per second while firing
  beamParticleRate: 26, // energy motes traveling along the beam per second
  impactParticleRate: 55, // sparks at the hit point per second
  maxParticles: 600, // global particle pool size

  // ---- Viewmodel ----
  viewmodelOffset: { x: 0.3, y: -0.26, z: -0.55 },
  fireJitter: 0.0045, // max positional jitter while firing (visual only)
  fireKickback: 0.02, // small backward slide of the viewmodel while firing

  // ---- Training targets ----
  targetMaxHP: 100,
  targetRespawnTime: 3.0,
};

export type WeaponConfigType = typeof WeaponConfig;