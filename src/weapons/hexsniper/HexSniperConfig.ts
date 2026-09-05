/**
 * HEX SNIPER — centralized configuration (no magic values elsewhere).
 *
 * Identity: a sniper rifle with a living monster head engaged in the
 * barrel. LMB projects the creature's TONGUE in the aim direction —
 * no maximum range, no expiry: it stops at the first collision (walls,
 * objects, players) or at the real map bounds. A grabbed PLAYER is
 * physically reeled toward the shooter (never teleported through walls);
 * any other contact triggers an empty return. RMB is a vigorous BITE:
 * two dedup'd contact windows (kit clip timing), never per-frame damage.
 *
 * The gameplay state machine + clip timings live in the vendored kit
 * (HexSniperAttacks.js / HexSniperController.js) — this file only tunes it.
 */
export const HexSniperConfig = {
  // ---- Tongue (LMB) ----
  /** Tongue tip flight speed (m/s) — near-instant, like a real sniper shot
   *  (120 m map crossed in 0.4 s worst case; no bullet time). The per-step
   *  segment sweep prevents tunneling at any speed. */
  projectileSpeed: 300,
  /** Empty-return speed of the tip toward the mouth (m/s) — snappy. */
  returnSpeed: 220,
  /** Reel-in speed of a grabbed player (m/s) — the fast pull is the point. */
  pullSpeed: 30,
  /** Flat damage applied to a player the instant the tongue grabs him. */
  tongueDamage: 50,
  /** Swept radius of the flying tongue (m) — a raycast alone is too thin. */
  tongueRadius: 0.08,
  /** Arrival gap kept between the victim and the shooter (m). */
  pullStopDistance: 1.6,
  /** Pull step blocked below this moved/intended ratio → release + retract. */
  pullBlockedRatio: 0.35,

  // ---- Bite (automatic after every tongue shot) ----
  /** Reach of the bite volume in front of the mouth (m). */
  biteRange: 1.1,
  /** Radius of the bite volume around its axis (m). */
  biteRadius: 0.6,
  /** Flat damage per BITE per target (the weapon dedups across the kit's
   *  two contact windows — a bite never deals damage twice to one target). */
  biteDamage: 50,
  /** Flat damage per bite on training targets (they use raw HP). */
  biteTargetDamage: 50,
  /** Horizontal knockback impulse on a bite hit (m/s). */
  biteKnockback: 9,
  /** Small pop-up so the bite knockback reads well (m/s). */
  biteVerticalKnockback: 3,
  /** Extra radius added to a combatant capsule for the bite hit test (m). */
  biteTargetRadius: 0.9,

  // ---- World queries ----
  /** Training-target hit sphere radius for the tongue sweep (m). */
  targetHitRadius: 0.85,
  /** Real map bounds (Ancient Jungle City is 120×120 m, physically walled;
   *  the box is generous — the perimeter walls stop the tongue first). */
  mapBounds: {
    min: { x: -160, y: -30, z: -160 },
    max: { x: 160, y: 150, z: 160 },
  },

  // ---- Aim-down-sights (RMB held) ----
  /** Classic sniper zoom: FOV divided by this while RMB is held. Mouse
   *  sensitivity is divided by the same factor for controllable aiming. */
  zoomFactor: 4,

  // ---- Viewmodel (camera-local; kit model faces -X, +Y up) ----
  /** Extra uniform scale on the weapon container (GLB is real-size ~1.3 m —
   *  scaled down to match the other viewmodels' FPS framing). */
  viewmodelScale: 0.55,
  /** Resting anchor of the viewmodel in camera space. */
  viewmodelOffset: { x: 0.32, y: -0.32, z: -0.58 },
  /** Projected-tongue width multiplier (1 = GLB scale). */
  tongueWidthScale: 1,

  // ---- Camera feedback ----
  biteShake: 0.25,
  grabShake: 0.18,
  arriveShake: 0.3,
} as const;

export type HexSniperConfigType = typeof HexSniperConfig;
