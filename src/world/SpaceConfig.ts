/**
 * Centralized configuration for the in-game sky ambiance:
 * skybox layers, moon(s), meteors, global lighting, fog and grading.
 *
 * Mood: "bright twilight" — a luminous end-of-day sky (golden horizon,
 * mauve band, deep-blue zenith) where the first stars, the moon and the
 * planets are already out. Everything visual lives here — no magic
 * numbers scattered in SpaceSky / JungleMap / Game.
 */
export const SpaceConfig = {
  /** Master switch for the whole sky backdrop (stars/nebula/moon/meteors). */
  spaceSkyEnabled: true,

  // ------------------------------------------------------------------
  // Sky dome (gradient background sphere, follows the camera)
  // ------------------------------------------------------------------
  /** Radius of the sky shell — must stay below the camera far plane (400). */
  skyRadius: 350,
  /** Rad/s — almost imperceptible drift of the star/nebula layers. */
  skyRotationSpeed: 0.0006,
  /** Renderer clear color behind everything (deep twilight blue). */
  backgroundColor: 0x141833,
  /** Dome gradient: color near the horizon (warm golden sunset glow). */
  horizonColor: 0xffa95e,
  /** Dome gradient: mid band between horizon and zenith (rose-mauve). */
  horizonMidColor: 0xb56a93,
  /** Dome gradient: color at the zenith (deep but still luminous blue). */
  zenithColor: 0x223064,

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
   * really "comes from" it. Kept LOW on the sky for the long warm
   * shadows of a late-afternoon / dusk sun.
   */
  moonPosition: { x: 0.45, y: 0.3, z: -0.66 },
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
  /** Hemisphere "dusk ambient": sky tint / ground tint / intensity. */
  spaceAmbientColor: 0xffc9a0, // warm peach sky bounce (sunset glow)
  spaceAmbientGroundColor: 0x59484f, // warm mauve-grey ground bounce
  spaceAmbientIntensity: 0.85,

  /** Main directional "low sun": warm gold, still bright. */
  moonLightColor: 0xffd9a6,
  moonLightIntensity: 1.9,

  /** Subtle cool blue rim/fill from the opposite low direction
   *  (the already-dark eastern sky answering the sunset). */
  rimLightColor: 0x6f86e8,
  rimLightIntensity: 0.4,

  // ------------------------------------------------------------------
  // Fog / grading
  // ------------------------------------------------------------------
  /** Light warm-mauve distance haze (never a ground fog). */
  fogColor: 0x6d5480,
  fogNear: 120,
  fogFar: 330,

  /** ACES filmic exposure — luminous dusk, warm highlights. */
  toneMappingExposure: 1.18,
} as const;