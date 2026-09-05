/**
 * LANCE-POISON — centralized configuration (no magic values elsewhere).
 *
 * Identity: a short-range continuous sprayer (flamethrower-style, but
 * toxic): hold LMB → a cone of glowing green poison melts anyone close.
 * The tank charge is the single source of truth — the HUD, the gameplay
 * drain AND the visible liquid level in the voxel tank all read it.
 *
 * The liquid visuals are driven by the GLB morph-target contract
 * (src/assets/contrat_liquide.json): Drain / TiltX / TiltZ / WaveSin /
 * WaveCos — see PoisonLiquidController.
 *
 * NETWORKED: the server mirrors the gameplay values in
 * shared/combat/NetworkWeapons.ts (NetworkWeaponConfig.poison) —
 * keep both in sync when tuning damage / range / drain.
 */
export const PoisonConfig = {
  // ---- Charge (the tank) ----
  /** Total charge units in a full tank. */
  capacity: 100,
  /** Charge drained per second while spraying (~7 s of continuous spray). */
  drainPerSecond: 14,
  /** Refill duration (R / auto when empty). The charge rises LINEARLY
   *  during the reload so the tank visibly fills up. */
  reloadDuration: 2.2,

  // ---- Damage (short-range continuous stream) ----
  /** High close-range DPS — the tradeoff for the very short reach. */
  damagePerSecond: 65,
  /** Max reach of the poison stream (m) — flamethrower-like. */
  range: 9,
  /** No headshots: a gas/liquid cone has no precise impact point. */
  supportsHeadshots: false,

  // ---- Poison cone particles (visual only) ----
  /** Droplets per second while spraying. */
  sprayParticleRate: 90,
  /** Initial droplet speed (m/s). */
  sprayParticleSpeed: 16,
  /** Cone half-angle dispersion (radians). */
  sprayConeAngle: 0.09,
  /** Droplet lifetime (s) — short: the cloud stays near the muzzle. */
  sprayParticleLife: 0.45,
  /** Impact splash particles per second on the struck surface. */
  impactParticleRate: 30,

  // ---- Liquid inertia (morph-target spring — contrat_liquide.json) ----
  /** Damped-spring natural frequency (Hz) of the surface tilt. */
  springFrequencyHz: 2.5,
  /** Damping ratio (0.6–0.85 looks liquid; 1 = no overshoot). */
  springDamping: 0.72,
  /** Low-pass time constant on the player acceleration input (s). */
  accelFilterTau: 0.05,
  /** Acceleration input clamp (m/s²) — kills teleport/jump spikes. */
  accelClamp: 60,
  /** Max spring integration sub-step (s) — stability at any FPS. */
  maxSubstep: 1 / 120,
  /** Global multiplier on the tilt response (1 = physical). */
  tiltGain: 1.0,
  /** Wave (WaveSin/WaveCos) amplitude per unit of motion energy. */
  waveAmplitude: 0.045,
  /** Wave phase speed (rad/s). */
  waveSpeed: 7.0,
  /** Tiny permanent agitation at rest (toxic bubbling feel). */
  idleAgitation: 0.006,
  /** How fast motion energy decays back to rest (1/s). */
  motionEnergyDecay: 2.2,

  // ---- Bubbles ----
  /** Full rise cycle duration of one bubble (s). */
  bubbleCycleSeconds: 2.6,
  /** Below this fill fraction the bubbles are hidden entirely. */
  bubbleMinFill: 0.08,

  // ---- Glow / appearance ----
  /** Bright toxic green used by lights / particles / HUD accents. */
  poisonColor: 0x39ff14,
  /** Emissive boost multiplier applied to the liquid material. */
  liquidEmissiveBoost: 1.35,
  /** Muzzle point-light intensity while spraying. */
  sprayLightIntensity: 2.6,
  /** Idle tank glow light intensity (0 disables). */
  tankLightIntensity: 0.55,

  // ---- Visual-only feedback ----
  /** Backward viewmodel slide while spraying (m). */
  sprayKickback: 0.014,
  /** Positional jitter while spraying (m). */
  sprayJitter: 0.003,
  /** Camera shake per second of spraying (FPSCamera.addShake units). */
  sprayCameraShakePerSecond: 0.12,

  // ---- Viewmodel placement (camera-local; muzzle faces -Z) ----
  /** Total viewmodel length of the sprayer (meters, camera space). */
  viewmodelLength: 0.72,
  viewmodelOffset: { x: 0.32, y: -0.34, z: -0.5 },
} as const;
