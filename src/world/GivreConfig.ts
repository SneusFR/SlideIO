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
   * reduced to the map's aspect seen from the sun → 2048 × 1024 on both).
   * HIGH used 4096 × 2048 REFRESHED EVERY FRAME: the whole map (both faces
   * of every double-sided mesh) re-rasterised into 8 M depth texels, plus
   * 4× bigger PCF lookups — a large fixed cost for ~8 cm/texel vs ~17 cm
   * now, invisible at gameplay distance with PCF filtering. LOW keeps
   * baking it once at load (staticShadows).
   */
  shadowMapSize: { HIGH: 2048, LOW: 2048 } as const,
  /** Low sun, long shadows: slightly stronger biases than v2 (acne-free). */
  shadowBias: -0.0006,
  shadowNormalBias: 0.08,

  // ------------------------------------------------------------------
  // Static-map draw batching (GivreRenderOptim — GPU cost, no visual change)
  // ------------------------------------------------------------------
  staticBatching: {
    /**
     * XZ grid the merged materials are split on (cells of ~93 × 110 m over
     * the playable envelope, same box as shadowBounds) → frustum culling +
     * front-to-back drawing. 71 batches (22 before the split). A finer 5 × 4
     * grid (226 batches) culled more triangles but cost ~215 draw calls in
     * the worst views — on integrated GPUs (Chrome → ANGLE → D3D11) every
     * draw costs main-thread CPU, which hurt more than it saved.
     */
    cellsX: 3,
    cellsZ: 2,
    /** Materials below this triangle count stay ONE mesh (not worth a split). */
    chunkMinTriangles: 6000,
    /**
     * Closed outward solids whose smallest side is ≤ this (m) — crates,
     * slabs, posts, bulbs — are drawn FrontSide (exact same image from
     * outside, half the rasterised triangles). 0 disables it.
     */
    singleSidedMaxThickness: 2,
  },
  /**
   * Draw the map with MeshStandardMaterial instead of the
   * MeshPhysicalMaterial GLTFLoader creates for KHR_materials_specular:
   * cheaper fragment shader on every map pixel. Colours, baked light,
   * shadows and roughness are unchanged — only the specular level of the
   * (very matte) surfaces moves to the standard 4 %: the ice / black-ice
   * highlights are a touch dimmer. `false` restores the Physical materials.
   */
  standardMaterials: true as boolean,
  /**
   * Mip levels of the 2048² baked lightmaps (1 = none, the old setup):
   * 3 = 2048 → 1024 → 512. Distant surfaces read a smaller level (no more
   * texture-cache thrashing) while the UV-island bleed stays a few texels.
   */
  lightmapMipLevels: 3,

  // ------------------------------------------------------------------
  // v3 client-only effects (see GivreEffects)
  // ------------------------------------------------------------------
  /** Length of the glb animation loop (s) — JSON `animations.loopSeconds`. */
  animationLoopSeconds: givrePhysics.animations?.loopSeconds ?? 8,

  // ------------------------------------------------------------------
  // Cel-shading outline defaults (GivreOutlinePass — see OutlineSettings)
  // ------------------------------------------------------------------
  outline: {
    /**
     * Feature switch for the white cel-shading rim. Currently DISABLED:
     * both GivreOutlinePass instances are still built (flip back to `true`
     * to restore them) but stay `enabled = false` (the composer skips them
     * at zero cost) and the menu OUTLINE section is hidden.
     */
    enabled: false as boolean,
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
