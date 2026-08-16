/**
 * REVOLVER — centralized configuration (no magic values elsewhere).
 *
 * Identity: an arcade ballistic revolver with PERFECT accuracy.
 *   LMB → one bullet (short cadence)
 *   RMB → FAN FIRE: commits to firing every remaining bullet very fast
 *   R   → throw the current revolver (explodes on first impact)
 *   Empty (LMB or fan fire) → automatic throw
 *   After any throw → a fresh revolver materializes holographically (6/6)
 *
 * Damage design (intentional, NOT the global x2 headshot rule):
 *   BODY = 100 (one-shot kill on a 100 HP bot)
 *   HEAD =  50 (two headshots to kill)
 */
export const RevolverConfig = {
  // ---- Cylinder ----
  revolverCapacity: 6,

  // ---- Cadence ----
  /** Minimum seconds between LMB shots (nervous but not an SMG). */
  revolverPrimaryFireInterval: 0.28,
  /** Seconds between fan-fire shots (BANG-BANG-BANG-BANG). */
  revolverFanFireInterval: 0.1,

  // ---- Hitscan ----
  /** Max bullet range in meters (camera-center raycast). */
  revolverRange: 300,
  /** Flat damage per zone — explicitly NOT the global headshot multiplier. */
  revolverBodyDamage: 100,
  revolverHeadDamage: 50,

  // ---- Thrown revolver (grenade mode) ----
  /** Initial forward speed of the thrown revolver (m/s). */
  revolverThrowSpeed: 24,
  /** Gravity applied to the thrown revolver (lighter than world gravity → readable arc). */
  revolverThrowGravity: 16,
  /** Self-rotation speed of the thrown revolver (rad/s). */
  revolverThrowSpinSpeed: 12,
  /** World-space length of the thrown revolver model (meters). */
  revolverThrownModelLength: 0.55,
  /** Safety net: a throw that somehow never collides explodes after this. */
  revolverProjectileMaxLifetime: 6,

  // ---- Explosion ----
  revolverExplosionRadius: 5,
  /** Fraction of MAX HP dealt to every enemy inside the radius (owner immune). */
  revolverExplosionDamageFraction: 0.25,

  // ---- Materialization (the ONLY unavailability window — no extra cooldown) ----
  /** Duration of the holographic materialize animation (seconds). */
  revolverMaterializeDuration: 0.45,

  // ---- Visual-only recoil (NEVER affects the raycast) ----
  /** Backward viewmodel kick per LMB shot (meters). */
  revolverVisualRecoil: 0.09,
  /** Backward viewmodel kick per fan-fire shot (smaller, but repeated fast). */
  revolverFanFireVisualRecoil: 0.06,
  /** Camera impulse per shot (FPSCamera.addShake units). */
  revolverShotCameraShake: 0.06,

  // ---- Viewmodel placement (camera-local) ----
  /** Total viewmodel length of the revolver (meters, camera space). */
  revolverViewmodelLength: 0.4,
  revolverViewmodelOffset: { x: 0.3, y: -0.3, z: -0.52 },
} as const;