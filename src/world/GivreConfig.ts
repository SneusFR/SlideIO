import givrePhysics from "../assets/MAP/Givre/givre_01.physics.json";

/**
 * Centralized visual configuration for the GIVRE 01 map ("Station
 * alpine"): its own sky, lighting rig and grading — the "Givre" preset of
 * the per-map atmosphere system (same role as YardConfig / SpaceConfig).
 *
 * Mood: bright alpine midday — flat pastel colours straight from the
 * Blender concept, sRGB output WITHOUT tone mapping (the concept's
 * "Standard" view transform), a low east-north-east sun and a cool blue
 * sky bounce. The colour / direction values come from the `lighting`
 * section of givre_01.physics.json (single source of truth, re-exported
 * by scripts/generate-givre-colliders.mjs).
 */
const lighting = givrePhysics.lighting;

export const GivreConfig = {
  // ------------------------------------------------------------------
  // Camera / sky dome
  // ------------------------------------------------------------------
  /**
   * Camera far plane on Givre. The background mountains (givre_01_fond.glb)
   * sit 1.6–6.4 km away, far beyond the 400 m used on the other maps. The
   * depth precision is driven by the 0.1 m near plane, so a far plane this
   * large costs nothing noticeable on the 280 m playfield.
   */
  cameraFar: 8000,
  /** Radius of the gradient sky sphere — must stay below cameraFar. */
  skyRadius: 7000,
  /** Gradient stops [fac, "#rrggbb"] along the view direction height. */
  skyStops: lighting.skyBackground.stops as [number, string][],
  /** Renderer clear colour (horizon tint — only visible on a context loss). */
  backgroundColor: lighting.skyBackground.stops[0][1] as string,

  // ------------------------------------------------------------------
  // Global lighting (three.js physical lights, r155+)
  // ------------------------------------------------------------------
  /** Hemisphere ambient: cool sky over light grey snow bounce. */
  ambientSkyColor: lighting.ambient.skyColorHex,
  ambientGroundColor: lighting.ambient.groundColorHex,
  /** π × Blender strength (Lambert BRDF divides by π in three.js). */
  ambientIntensity: Math.PI * lighting.ambient.blenderStrength,

  /** Sun: warm white, east-north-east, 36° above the horizon. */
  sunLightColor: lighting.sun.colorHex,
  sunLightIntensity: lighting.sun.blenderStrength,
  /** Normalized direction TOWARD the sun (three.js world space). */
  sunDirection: {
    x: lighting.sun.directionToSun[0],
    y: lighting.sun.directionToSun[1],
    z: lighting.sun.directionToSun[2],
  },
  /** Distance of the light from its target (origin) along sunDirection. */
  sunDistance: 300,
  /** Half extent of the orthographic shadow camera (map = 280 m). */
  shadowExtent: 150,

  // ------------------------------------------------------------------
  // Cel-shading outline defaults (GivreOutlinePass — see OutlineSettings)
  // ------------------------------------------------------------------
  outline: {
    color: "#f6f9ff",
    intensity: 0.85,
    /** CSS pixels (scaled by the renderer pixel ratio) — 1 ≈ 2 px line. */
    thickness: 1,
    normalThreshold: 0.4,
    depthThreshold: 0.02,
    fadeStart: 150,
    fadeEnd: 400,
    outlineSky: true,
  },
} as const;
