/**
 * BASS BLASTER — centralized configuration (no magic values elsewhere).
 *
 * Identity: a MUSICAL SMG. Gameplay-wise it behaves like a classic SMG
 * (fast fire rate, low damage per bullet, 30-round magazine, manual
 * reload), but every visual and audio element is themed around music:
 *   - each bullet is a glowing MUSICAL NOTE projectile;
 *   - notes cycle through the scale Do→Ré→Mi→Fa→Sol→La→Si→Do', each with
 *     its own bright color;
 *   - each shot plays a tiny positional FRAGMENT of the selected music
 *     track, carried by the note as it flies (granular playback);
 *   - reloading summons a swirl of musical notes into the weapon.
 *
 * LOCAL-ONLY for now: intentionally NOT networked (no server counterpart).
 */
export const BassBlasterConfig = {
  // ---- Magazine / cadence (SMG profile) ----
  magazineSize: 30,
  /** Seconds between shots while the trigger is held (~11.8 rounds/s). */
  fireInterval: 0.085,
  /** Manual/auto reload duration (musical note swirl animation). */
  reloadDuration: 1.2,

  // ---- Damage (SMG) ----
  bodyDamage: 20,
  headDamage: 40, // weapon-specific ×2 head bonus

  // ---- Note projectiles ----
  /** Forward speed of a fired note (m/s). */
  projectileSpeed: 140,
  /** Max flight time before a note fizzles out (s) → ~224 m range. */
  projectileLifetime: 1.6,
  /** Camera-center aim raycast range used to converge the muzzle shot. */
  aimRange: 250,
  /** World scale of the note glyph sprite (m). */
  noteGlyphScale: 0.34,
  /** World scale of the additive halo behind the glyph (m). */
  noteHaloScale: 0.62,
  /** Trail particles emitted per second per flying note. */
  trailParticlesPerSecond: 30,
  trailParticleLife: 0.28,
  /** Impact FX. */
  impactBurstCount: 12,
  impactRingCount: 14,

  // ---- Music fragments (granular playback) ----
  /** Audible length of the micro-fragment carried by ONE note (s). */
  fragmentDuration: 0.095,
  /** How far the track playhead advances per shot (s) — same order of
   *  magnitude as the fragment so sustained fire feels continuous. */
  playheadAdvancePerShot: 0.085,
  /** Volume of each positional fragment (weapons bus). */
  fragmentVolume: 0.9,
  /** Spatialization of the fragments (carried by the flying notes). */
  fragmentRefDistance: 9,
  fragmentMaxDistance: 130,
  fragmentRolloff: 1.15,

  // ---- Reload VFX (musical note swirl) ----
  /** Number of notes orbiting into the weapon during a reload. */
  reloadNoteCount: 10,
  /** Start radius of the swirl around the viewmodel (m, camera space). */
  reloadSwirlRadius: 0.42,
  /** Revolutions each note makes while converging. */
  reloadSwirlTurns: 1.6,

  // ---- Visual-only recoil / feedback ----
  /** Backward viewmodel kick per shot (m). */
  visualRecoil: 0.035,
  /** Camera impulse per shot (FPSCamera.addShake units). */
  shotCameraShake: 0.018,
  /** Muzzle flash light intensity per shot. */
  muzzleFlashIntensity: 5.5,

  // ---- Viewmodel placement (camera-local) ----
  /** Total viewmodel length of the blaster (meters, camera space). */
  viewmodelLength: 0.62,
  viewmodelOffset: { x: 0.32, y: -0.3, z: -0.58 },

  // ---- Track selector UI ----
  /** Seconds of inactivity before the selection panel auto-minimizes. */
  selectorIdleSeconds: 3.2,
} as const;