/**
 * Central tuning for all loot pickups (medkits, coins).
 * No magic values in the pickup logic — everything lives here.
 * Units: meters, seconds, HP.
 */
export const PickupConfig = {
  // ---- Medkit ----
  medkitHealAmount: 35,
  medkitLifetime: 25,
  medkitPickupRadius: 1.15,
  medkitSize: 0.5, // largest dimension of the model after normalization
  medkitHoverHeight: 0.42, // rest height of the model center above the ground
  medkitBobSpeed: 2.2,
  medkitBobHeight: 0.07,
  medkitSpinSpeed: 1.1, // rad/s slow idle rotation
  medkitsPerKill: 1,

  // ---- Coins ----
  coinDropMin: 2,
  coinDropMax: 10,
  coinDropRadius: 1.0, // scatter radius around the death point
  coinLifetime: 20,
  coinPickupRadius: 0.95,
  coinSize: 0.3,
  coinHoverHeight: 0.24,
  coinBobSpeed: 3.2,
  coinBobHeight: 0.05,
  coinSpinSpeed: 2.8, // rad/s — coins visibly spin on themselves
  coinPopDuration: 0.42, // arc time from the death point to the landing spot
  coinPopHeight: 0.55, // apex of the pop arc

  // ---- Shared ----
  pickupVerticalTolerance: 1.7, // vertical slack for the distance-based pickup check
  maxActivePickups: 96, // hard cap during long FFA sessions
  fadeOutDuration: 0.6, // scale-down time before an expired pickup vanishes
  groundRaycastUp: 0.6, // ray origin above the death point
  groundRaycastDown: 8, // max distance to look for the floor

  // ---- Particles (shared budget — readability over quantity) ----
  sparkleRate: 2.2, // sparkles per second per pickup
  maxSparklesPerFrame: 3, // global budget so 50 coins never flood the emitter
};

export type PickupConfigType = typeof PickupConfig;