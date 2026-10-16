import givrePhysics from "../assets/MAP/Givre/givre_01.physics.json";

/**
 * Centralized visual configuration for the GIVRE 01 map ("Station
 * alpine"): its own sky, lighting rig and grading — the "Givre" preset of
 * the per-map atmosphere system (same role as YardConfig / SpaceConfig).
 *
 * Mood (v3, "fin_apres_midi"): late afternoon — a low (17°) golden sun in
 * the west-south-west casting long shadows, a deeper blue sky and a weaker,
 * bluer ambient. Flat colours straight from the Blender concept, sRGB
 * output WITHOUT tone mapping (the concept's "Standard" view transform).
 * Interiors are lit by the BAKED light carried by the glb materials
 * (emissiveMap + aoMap) — no live lamp. The colour / direction values come
 * from the `lighting` section of givre_01.physics.json (single source of
 * truth, re-exported by scripts/generate-givre-colliders.mjs).
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
  /**
   * Hemisphere ambient: blue sky over warm snow bounce. The glb aoMap
   * (sky visibility) switches it off inside rooms / under the hall — it
   * only affects this light, never the sun nor the baked emissive.
   */
  ambientSkyColor: lighting.ambient.skyColorHex,
  ambientGroundColor: lighting.ambient.groundColorHex,
  /** π × Blender strength (Lambert BRDF divides by π in three.js). */
  ambientIntensity: Math.PI * lighting.ambient.blenderStrength,

  /** Sun: golden, west-south-west, 17° above the horizon (long shadows). */
  sunLightColor: lighting.sun.colorHex,
  sunLightIntensity: lighting.sun.blenderStrength,
  /** Normalized direction TOWARD the sun (three.js world space). */
  sunDirection: {
    x: lighting.sun.directionToSun[0],
    y: lighting.sun.directionToSun[1],
    z: lighting.sun.directionToSun[2],
  },
  /** Distance of the light from its target (map centre) along sunDirection. */
  sunDistance: 300,
  /**
   * World box the sun's shadow camera is FITTED to (v3): the playable
   * envelope (X [−140, 140], Z [−140, 80]) from Y −1 to 21 m (top of the
   * static décor). Seen from the low sun the map is ~340 × 125 m, hence a
   * rectangular shadow map. The old ±150 m square centred on the origin
   * left a ~40 m unshadowed band in the north-west (Stock).
   */
  shadowBounds: {
    min: [-140, -1, -140] as const,
    max: [140, 21, 80] as const,
  },
  /**
   * Longest side of the shadow map per quality preset (the other side is
   * reduced to the map's aspect seen from the sun → 4096 × 2048 on HIGH,
   * 2048 × 1024 on LOW, where the map is baked once at load).
   */
  shadowMapSize: { HIGH: 4096, LOW: 2048 } as const,
  /** Low sun, long shadows: slightly stronger biases than v2 (acne-free). */
  shadowBias: -0.0006,
  shadowNormalBias: 0.08,

  // ------------------------------------------------------------------
  // v3 client-only effects (see GivreEffects)
  // ------------------------------------------------------------------
  /** Length of the glb animation loop (s) — JSON `animations.loopSeconds`. */
  animationLoopSeconds: givrePhysics.animations?.loopSeconds ?? 8,

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
