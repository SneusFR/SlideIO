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
  medkitSize: 1.0, // largest dimension of the model after normalization (2x — readability)
  medkitHoverHeight: 0.68, // rest height of the model center above the ground
  medkitBobSpeed: 2.2,
  medkitBobHeight: 0.07,
  medkitSpinSpeed: 1.1, // rad/s slow idle rotation
  medkitsPerKill: 1,
  /** Ammo refill granted by a medkit: random fraction of the weapon's
   *  magazine, rolled uniformly in [min, max] at collection time. */
  medkitAmmoRefillMinFraction: 0.25,
  medkitAmmoRefillMaxFraction: 0.75,

  // ---- Coins ----
  coinDropMin: 2,
  coinDropMax: 10,
  coinDropRadius: 1.0, // scatter radius around the death point
  coinLifetime: 20,
  coinPickupRadius: 0.95,
  coinSize: 0.6, // (2x — readability)
  coinHoverHeight: 0.42,
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

  // ---- Mesh decimation (collectables don't need high-poly models) ----
  /**
   * Vertex-clustering grid resolution used to simplify the pickup GLBs at
   * load time. The source models are absurdly dense for collectables
   * (coin ≈ 44k tris, medkit ≈ 31k tris) — with dozens of drops on the
   * ground this tanked the framerate. ~32 cells across the largest axis
   * keeps the silhouette while cutting the triangle count by ~95%.
   */
  meshDecimateGrid: 32,
  /** Meshes under this vertex count are left untouched. */
  meshDecimateMinVertices: 3000,

  // ---- Glow (self-lit material + additive halo billboard) ----
  glowEmissiveIntensity: 0.85, // self-illumination boost applied to the GLB materials
  glowHaloScale: 2.4, // halo sprite diameter relative to the pickup size
  glowHaloOpacity: 0.55, // base opacity of the additive halo
  medkitGlowColor: 0x4ade80, // green — matches the sparkle tint
  coinGlowColor: 0xfcd34d, // warm gold — matches the sparkle tint
};

export type PickupConfigType = typeof PickupConfig;