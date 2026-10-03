import * as THREE from "three";

/**
 * PAINT JET SETTINGS — every tunable of the paintball jets in ONE place
 * (flight, elastic body, shape, FPS readability, look, droplets, impact,
 * weapon kick).
 * Read by PaintJets (simulation + look), the Paintball controller (kick).
 */

/** Paint colours (sRGB hex): pink, blue, yellow. Index = the `pc` sent on the wire. */
export const PAINT_COLORS_SRGB: readonly number[] = [0xff4fa3, 0x2ea8ff, 0xffd91a];

/** Palette as THREE.Color (working / linear space). */
export function paintPaletteColors(): THREE.Color[] {
  return PAINT_COLORS_SRGB.map((hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace));
}

/** Palette as linear RGB triplets (the hopper data format). */
export function paintPaletteLinear(): number[][] {
  return paintPaletteColors().map((c) => [c.r, c.g, c.b]);
}

/**
 * Shared jet geometry (ONE mesh for every jet): RADIAL vertices per ring,
 * BODY_RINGS rings from the pointed tail to the nose base, NOSE_RINGS rings
 * on the rounded nose cap. The vertex shader shapes it per jet.
 */
export const RADIAL = 12;
export const BODY_RINGS = 18;
export const NOSE_RINGS = 6;

export const PAINT_JET = {
  // ---- flight (unchanged: speed, flight time) ----
  /** Mean head speed (m/s). 95 m/s = a 10 shots/s burst leaves ~9.5 m gaps between jets. */
  speed: 95,
  /** ± share of the speed randomised per jet. */
  speedJitter: 0.1,
  /** Head flight time bounds (s): ≥ 2 frames at point blank, ≤ 0.35 s whatever the distance. */
  minFlight: 2 / 60,
  maxFlight: 0.35,

  // ---- elastic body: BORN stretched, stays a LONG jet (8-12× its thickness) until the impact ----
  // With volume conservation, length / thickness = L^1.5 / (2 · radius · √refLength):
  // 0.93 m → 8.2×, 1.06 m → 9.9×, 1.20 m → 11.9×. It never contracts into a ball.
  /** Length (m) on the very first frame: already a long liquid jet. */
  launchLength: 1.2,
  /** Rest length (m) the jet relaxes to (one soft, slight contraction) and its ± per-jet share. */
  restLength: 1.06,
  restJitter: 0.05,
  /** The body never shrinks below / stretches beyond these lengths (m): 8.2× … 11.9× its thickness. */
  minLength: 0.93,
  maxLength: 1.2,
  /** Relaxation spring: frequency (Hz) + ± per-jet share, damping ratio (0.6 = barely one undershoot). */
  springHz: 7,
  springHzJitter: 0.2,
  damping: 0.6,
  /** Length (m) at which the radius is nominal: volume is conserved (r² · L constant). */
  refLength: 1.0,
  minRadiusScale: 0.85,
  maxRadiusScale: 1.1,
  /**
   * In-flight elasticity: the rest length keeps BREATHING (± this share, at
   * breatheHz ± jitter, per-jet phase), so the body keeps stretching / thinning
   * a little during the whole flight instead of freezing into a rigid spike.
   * ±4.5 % of the length = the ratio stays inside 9-11× (the silhouette stays long).
   */
  breathe: 0.045,
  breatheHz: 6,
  breatheHzJitter: 0.25,
  /** Fixed sub-step of the spring (s): frame-rate independent. */
  springStep: 1 / 180,
  /** The start stays on the live muzzle until the tail is this far (m) from it. */
  anchorRelease: 0.06,

  // ---- shape (ONE shared geometry, shaped in the vertex shader) ----
  /** Nominal jet radius (m) = half the thickness at the nose (unchanged). */
  radius: 0.055,
  /** Nose cap length = this × the nose radius (1 = hemisphere, > 1 = slightly ogival): lightly rounded front. */
  noseRound: 1.35,
  /** Body profile sin(u·π/2)^taper from the pointed tail (u = 0) to the nose (u = 1), ± per-jet share. */
  taper: 1.25,
  taperJitter: 0.2,
  /** Elastic, asymmetric deformation (× nose radius): lateral sway of the thin tail, oval breathing of the section. */
  sway: 0.35,
  ovality: 0.07,
  /**
   * Soft-paint asymmetry: the middle of the body bows slightly to one side
   * (× nose radius, slow, per-jet direction) and ONE thinner "neck" slides from
   * behind the nose toward the tail (share of the radius) — the paint pulls
   * and thins, it never looks like a rigid spike. Not periodic ripples.
   */
  bow: 0.28,
  neck: 0.16,
  neckHz: 3.2,

  // ---- FPS readability ----
  /** Minimum ON-SCREEN radius (rad): a far jet never thins to nothing (it gets longer as much, same proportions). */
  minAngularRadius: 0.0035,
  /** Max on-screen radius (rad) near the camera: at the FP muzzle it never fills the view. */
  maxAngularRadius: 0.04,
  /**
   * Seen almost along its flight (the FPS case: it leaves the gun toward the
   * crosshair), a jet would shrink to a dot. The drawn axis is then turned,
   * around the head and ONLY in the plane (camera, head, flight), until the
   * jet is at least this many times longer than wide on screen: it stays
   * exactly on the screen line muzzle → impact, and never goes past the muzzle.
   */
  minScreenAspect: 7,
  /** Upper bound (m) of the drawn length far away (beyond it the jet gets thinner, same proportions). */
  maxDrawLength: 4,

  // ---- look ----
  /** Built-in fill light (0 = scene lighting only). NOT a glow. */
  glow: 0.2,
  /** Base roughness of the paint (slightly glossy). */
  roughness: 0.34,
  /** Wet look: small sharp highlight + thin top sheen (emissive add), and the thin dark edge (0 = none, 1 = black). */
  wetSpecular: 0.3,
  wetSheen: 0.1,
  rimDark: 0.45,
  /** Width of the dark edge as N·V (0.35 ≈ the outer 6 % of each side). */
  rimWidth: 0.35,

  // ---- droplets (≈ 1/3 of the previous amount; the jet stays dominant) ----
  gravity: 9.8,
  /** Small stretched droplets thrown out of the barrel on each shot. */
  muzzleDrops: 2,
  /** Muzzle / shed droplet radius (m) + random extra: small and discreet next to the jet. */
  dropRadius: 0.0035,
  dropRadiusJitter: 0.0045,
  /** Droplets torn off by a strained body (per second at full stretch) + the stretch needed. */
  shedRate: 14,
  shedMinStretch: 0.45,
  /** Droplets thrown sideways on impact. */
  splashDrops: 5,
  /** Droplets never shrink below this on-screen radius (rad). */
  dropMinAngle: 0.0015,

  // ---- impact: SQUASH → SPREAD → TRACE (soft paint thrown hard, never a stamp) ----
  // 1) the nose stops on the surface, the body keeps coming and DRAINS into it;
  // 2) the paint blob SLAMS flat (thick dome → thin pancake), spreads past its
  //    size (elastic overshoot), smeared forward on a slanted hit, and recoils;
  // 3) the persistent splat appears UNDER it as a small round puddle and
  //    SPREADS (core, then the fingers, then the satellite drops) while the
  //    pancake thins and sinks into it — the trace is what the paint left.
  /** Time (s) the rest of the jet takes to sink into the impact (nose buried in the surface). */
  impactDrain: 0.035,
  /** Pancake start radius (m) ≈ the jet radius, and its start half-thickness (m): a blob taller than wide. */
  impactStartRadius: 0.06,
  impactStartHeight: 0.075,
  /** Pancake final radius = this share of the splat core: the puddle edge stays visible around it. */
  impactFill: 0.8,
  /** Time (s) the pancake takes to reach its size, and its elastic overshoot (easeOutBack constant: 1.7 ≈ +10 %). */
  impactSpread: 0.085,
  impactOvershoot: 1.7,
  /** Slanted hit: the pancake is stretched along the travel direction by up to this share (× sin of the incidence). */
  impactSmear: 0.45,
  /** Persistent splat: created this long (s) after the hit as a small puddle, then spreads to its shape over impactGrow (s). */
  impactSplatAt: 0.02,
  impactGrow: 0.2,
  /** Total pancake life (s): it thins from ~45 % of it and sinks into the splat. */
  impactLife: 0.22,
  /** Splat size variation: base size × (1 ± this/2), from the shot seed (same on every client). */
  splatSizeVariation: 0.5,

  // ---- weapon kick: sharp recoil + soft return, SET on each shot (never accumulated) ----
  /** Peak backward displacement (m) of the viewmodel. */
  kickPeak: 0.014,
  /** Critically damped spring (rad/s): peak after 1/ω ≈ 18 ms, back to 5 % after ≈ 5.7/ω ≈ 104 ms. */
  kickOmega: 55,
  /** Muzzle-up pitch (rad per metre of kick). */
  kickPitch: 0.8,

  // ---- paint ----
  /** Paint radius on a character (m): 3× the pack's 7.5 cm (unchanged from the balls). */
  paintRadius: 0.225,
} as const;
