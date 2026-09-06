/**
 * Centralized visual configuration for the YARD 01 Expanded map:
 * its own skybox (bright midday), lighting rig, fog and grading.
 *
 * Mood: "clear industrial early afternoon (~14h)" — a bright blue sky
 * over the concrete yard, a high white sun, a few white clouds and a
 * faint acid-green sheen over the west pool. Deliberately DISTINCT from
 * the Jungle map's violet space twilight (see SpaceConfig).
 */
export const YardConfig = {
  // ------------------------------------------------------------------
  // Sky dome (gradient background sphere, follows the camera)
  // ------------------------------------------------------------------
  /** Radius of the sky shell — must stay below the camera far plane (400). */
  skyRadius: 350,
  /** Renderer clear color behind everything (bright daylight blue). */
  backgroundColor: 0x87b8e8,
  /** Dome gradient: color near the horizon (pale sunlit haze). */
  horizonColor: 0xdcebf5,
  /** Dome gradient: mid band (light summer blue). */
  horizonMidColor: 0x8fc3ee,
  /** Dome gradient: zenith (saturated midday blue). */
  zenithColor: 0x3577c9,

  // ------------------------------------------------------------------
  // Sun / glows (canvas sprites — no real light cost)
  // ------------------------------------------------------------------
  /** Direction of the high afternoon sun (~14h — high, slightly SW). */
  sunPosition: { x: -0.35, y: 0.82, z: -0.45 },
  /** Sun disk sprite scale (smaller: a high midday sun reads compact). */
  sunScale: 60,
  /** Faint acid-green sheen direction (over the west wing / pool). */
  acidGlowPosition: { x: -0.85, y: 0.12, z: 0.3 },
  acidGlowScale: 170,
  acidGlowOpacity: 0.22,
  /** Drifting white cloud sprite count + base opacity. */
  smogSprites: 3,
  smogIntensity: 0.55,

  // ------------------------------------------------------------------
  // Global lighting
  // ------------------------------------------------------------------
  /** Hemisphere ambient: bright blue sky over sunlit concrete ground. */
  ambientSkyColor: 0xcfe4ff,
  ambientGroundColor: 0x9a938a,
  ambientIntensity: 1.05,

  /** Main directional "high afternoon sun": near-white, strong. */
  sunLightColor: 0xfff4e0,
  sunLightIntensity: 2.4,

  /** Cool sky-blue fill from the west (open-sky bounce). */
  rimLightColor: 0xa8c8f0,
  rimLightIntensity: 0.3,

  // ------------------------------------------------------------------
  // Fog / grading
  // ------------------------------------------------------------------
  /** Light atmospheric blue haze melting the far wings (never a ground fog). */
  fogColor: 0xa9c6e2,
  fogNear: 150,
  fogFar: 380,

  /** ACES filmic exposure — bright clean daylight. */
  toneMappingExposure: 1.2,
} as const;
