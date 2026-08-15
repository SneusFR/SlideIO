/**
 * Centralized configuration for the in-game deep-space ambiance:
 * skybox layers, moon(s), meteors, global lighting, fog and grading.
 *
 * Everything visual about the "futuristic purple deep space" mood lives
 * here — no magic numbers scattered in SpaceSky / TdmMap / Game.
 */
export const SpaceConfig = {
  /** Master switch for the whole space backdrop (stars/nebula/moon/meteors). */
  spaceSkyEnabled: true,

  // ------------------------------------------------------------------
  // Sky dome (gradient background sphere, follows the camera)
  // ------------------------------------------------------------------
  /** Radius of the sky shell — must stay below the camera far plane (400). */
  skyRadius: 350,
  /** Rad/s — almost imperceptible drift of the star/nebula layers. */
  skyRotationSpeed: 0.0006,
  /** Renderer clear color behind everything (deep space black). */
  backgroundColor: 0x030209,
  /** Dome gradient: color near the horizon (dark blue-violet). */
  horizonColor: 0x141026,
  /** Dome gradient: color at the zenith (near-black). */
  zenithColor: 0x030209,

  // ------------------------------------------------------------------
  // Stars
  // ------------------------------------------------------------------
  /** Total number of star points (single GPU draw call). */
  starCount: 1400,
  /** Extra stars packed into a few dense clusters for composition. */
  starClusterCount: 3,
  /** Stars per cluster (taken out of a separate buffer, still one draw). */
  starsPerCluster: 90,
  /** 0 = static stars, 1 = full fade in/out. Keep subtle. */
  starTwinkleIntensity: 0.45,
  /** Base star color (cool white, slightly lavender). */
  starColor: 0xe8e2ff,
  /** Fraction of stars tinted violet / blue for variety. */
  starVioletFraction: 0.18,
  starBlueFraction: 0.15,

  // ------------------------------------------------------------------
  // Nebula (few big additive sprites — very diffuse, lots of black kept)
  // ------------------------------------------------------------------
  /** Number of nebula sprites (kept low: sky must stay mostly black). */
  nebulaSprites: 4,
  /** Global opacity multiplier for the nebula layer. */
  nebulaIntensity: 0.34,

  // ------------------------------------------------------------------
  // Moon / planets
  // ------------------------------------------------------------------
  /** Moon sphere radius (world units on the sky shell). */
  moonScale: 26,
  /**
   * Direction of the moon on the sky (normalized at runtime).
   * The main DirectionalLight matches this direction so the light
   * really "comes from the moon" (visible from the street looking NE-up).
   */
  moonPosition: { x: 0.42, y: 0.52, z: -0.68 },
  /** Violet rim halo around the moon (0 disables). */
  moonHaloOpacity: 0.5,
  /** Secondary distant astre: small dark silhouette planet. */
  secondPlanetEnabled: true,
  secondPlanetScale: 9,
  secondPlanetPosition: { x: -0.75, y: 0.22, z: 0.55 },

  // ------------------------------------------------------------------
  // Meteors (occasional shooting stars — decorative sprites)
  // ------------------------------------------------------------------
  /** Seconds between meteors (random in [min, max]). */
  meteorMinInterval: 5,
  meteorMaxInterval: 15,
  /** Base flight speed in world units/s (randomized ±40%). */
  meteorSpeed: 260,
  /** Seconds a meteor stays alive (randomized ±30%). */
  meteorLifetime: 0.9,
  /** Base trail length in world units (randomized per meteor). */
  meteorLength: 40,
  /** Max simultaneous meteors (pooled — no runtime allocation). */
  meteorPoolSize: 3,

  // ------------------------------------------------------------------
  // Global lighting
  // ------------------------------------------------------------------
  /** Hemisphere "space ambient": sky tint / ground tint / intensity. */
  spaceAmbientColor: 0x8d84c9, // dark violet-blue sky bounce
  spaceAmbientGroundColor: 0x3a3540, // neutral dark ground bounce
  spaceAmbientIntensity: 0.62,

  /** Main directional "moonlight": cool white, barely violet. */
  moonLightColor: 0xdcd8ff,
  moonLightIntensity: 1.5,

  /** Subtle violet rim/fill light from the opposite low direction. */
  rimLightColor: 0x7c3aed,
  rimLightIntensity: 0.3,

  // ------------------------------------------------------------------
  // Fog / grading
  // ------------------------------------------------------------------
  /** Very light dark blue/purple distance haze (never a ground fog). */
  fogColor: 0x0b0817,
  fogNear: 120,
  fogFar: 330,

  /** ACES filmic exposure — deep blacks, cool premium highlights. */
  toneMappingExposure: 1.12,
} as const;