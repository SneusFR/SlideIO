/**
 * All tuning values for the OBLITERREUR — the anchored black-vortex weapon.
 *
 * RMB places two mini black-hole anchor points on static surfaces;
 * LMB unleashes a huge curved black-vortex beam between them for a few
 * seconds, damaging every combatant inside the curved tube volume
 * (walls are ignored by design — the vortex devours through matter).
 */
export const ObliterreurConfig = {
  // ---- Beam gameplay ----
  /** Beam lifetime in seconds once fired. */
  obliterreurBeamDuration: 5.0,
  /** Fraction of MAX HP dealt per second inside the beam volume. */
  obliterreurDamagePerSecondFraction: 0.5,
  /** Damage-volume radius of the beam tube (meters). */
  obliterreurBeamRadius: 0.55,
  /** Extra radius added to a combatant's center for the hit test. */
  obliterreurTargetHitRadius: 0.85,
  /** Damage tick frequency (Hz) — damage itself stays framerate-independent. */
  obliterreurDamageTickRate: 25,

  // ---- Curve shape ----
  /** Bezier handle length = chord length * this (bulge of the arc). */
  obliterreurCurveStrength: 0.45,
  /** Minimum bezier handle length (meters). */
  obliterreurCurveHandleMin: 2.0,
  /** Maximum bezier handle length (meters). */
  obliterreurCurveHandleMax: 14.0,
  /** Number of segments used for the damage polyline sampling. */
  obliterreurCurveSampleCount: 48,

  // ---- Placement ----
  /** Max distance of the RMB placement raycast (meters). */
  obliterreurPlacementRange: 200,
  /** Anchor points hover slightly off the surface to avoid z-fighting. */
  obliterreurPointSurfaceOffset: 0.04,
  /** Visual radius of a black-hole anchor marker disc. */
  obliterreurMarkerRadius: 0.42,

  // ---- Visuals ----
  /** Glow shell radius = beam radius * this. */
  obliterreurGlowRadiusScale: 1.35,
  /** Angular speed of the swirling vortex texture. */
  obliterreurVortexRotationSpeed: 1.6,
  /** Suction particles spawned per second along the beam. */
  obliterreurParticleRate: 70,
  /** Bright electric sparks ejected per second from the beam surface. */
  obliterreurSparkRate: 40,
  /** Outer lightning-arc shell radius = beam radius * this. */
  obliterreurArcRadiusScale: 2.3,
  /** Ragged-silhouette vertex noise, as a fraction of each shell's radius. */
  obliterreurCoreNoiseAmp: 0.45,
  obliterreurGlowNoiseAmp: 0.6,
  obliterreurArcNoiseAmp: 1.0,
  /** Beam grow-in duration (seconds). */
  obliterreurAppearDuration: 0.18,
  /** Beam implosion duration on natural expiry (seconds). */
  obliterreurImplodeDuration: 0.28,
  /** Faster implosion when the beam is cancelled by a new RMB anchor. */
  obliterreurCancelImplodeDuration: 0.12,
  /** Violet point-light intensity at the two beam endpoints. */
  obliterreurEndpointLightIntensity: 2.5,
  /** Violet point-light range at the two beam endpoints. */
  obliterreurEndpointLightDistance: 12,

  // ---- Camera feedback ----
  /** Camera shake when an anchor point is placed. */
  obliterreurPlaceShake: 0.06,
  /** Camera shake when the beam fires. */
  obliterreurFireShake: 0.35,

  // ---- Viewmodel ----
  /** Normalized GLB length along -Z (meters, view space). */
  viewmodelLength: 0.95,
  /** Resting anchor of the viewmodel in camera space. */
  viewmodelOffset: { x: 0.36, y: -0.44, z: -0.72 },
} as const;