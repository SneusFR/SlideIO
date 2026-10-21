import * as THREE from "three";

/**
 * PERF — the Givre map's fragment shader, specialised for what the map really
 * uses. The map is drawn with three's MeshStandardMaterial (the merged "uber"
 * materials of MapBatching, the lamp panels, the backdrop): the general PBR
 * shader, which evaluates terms the map never needs. Checked on the real data
 * (`mapShaderEligibility`, scripts/test-givre-render-optim.mts) and on the
 * bench (pixel A/B, several poses, LOW and HIGH):
 *
 * EXACT — same pixels (every removed term adds exactly zero, or a value is
 * computed once instead of twice), on by default, `?diag=nomapshader` = off:
 *  - `noIbl`: no environment map → the image-based specular term
 *    (RE_IndirectSpecular: two DFG LUT fetches, two computeMultiscattering,
 *    ~60 ALU per pixel) is multiplied by radiance = irradiance = 0: it adds
 *    exactly 0 to the light. Not evaluated (kept as soon as an env map exists:
 *    `#ifndef USE_ENVMAP`).
 *  - `dielectric`: metalness ≡ 0 on every vertex of the map → constant-folded
 *    (diffuse × (1 − 0) and mix(0.04, diffuse, 0) are exact), the aMetalness
 *    attribute and its varying are no longer read / interpolated.
 *  - `sharedUv`: the emissive and AO lightmaps read the same `uv` with the
 *    same transform → one varying instead of two (bit-identical values).
 *  - `sunSkip`: the sun's shadow lookup (5 PCF taps, 5 cos + 5 sin) and BRDF
 *    (GGX + its two DFG fetches) only where they can add light: a surface
 *    facing away from the sun has saturate(N·L) = 0 (irradiance exactly 0), a
 *    pixel fully in the sun's shadow has a shadow factor of exactly 0 (all
 *    five taps occluded) — in both cases the stock shader adds exactly 0. The
 *    lookups inside the branch use an explicit LOD 0 (the shadow map and the
 *    DFG LUT have a single level: the same texels, the same filter).
 *
 * NEAR-EXACT — `?diag=mapshaderfast` (a visual trade-off for the owner to
 * decide, ≤ 1 level on 8-bit output before anti-aliasing, on a few pixels):
 *  - `noDirectMs`: the sun's multiple-scattering energy compensation
 *    (BRDF_GGX_Multiscatter → BRDF_GGX: two DFG LUT fetches + ~40 ALU). For
 *    F0 = 0.04 (dielectric) it is at most 6.6e-5 in linear radiance (bound
 *    over the whole DFG LUT, full sun) — under a quarter of one output level
 *    even next to black; it can only tip a rounding.
 *  - `pcfRotate`: the shadow's 5 Vogel-disk taps rotated by the per-pixel
 *    angle with ONE cos / sin pair instead of five (cos(a + φ) expanded):
 *    the same taps up to float rounding (≈ 1e-6 texel).
 *
 * Everything is decided at load (GivreMap): the specialised materials are in
 * the scene for the GPU warm-up — no shader compile in play.
 */

export interface MapShaderOptions {
  /** No environment map: drop the image-based specular term (exact). */
  noIbl: boolean;
  /** Metalness ≡ 0 on the material's vertices: constant-folded (exact). */
  dielectric: boolean;
  /** Emissive + AO lightmaps on the same uv / transform: one varying (exact). */
  sharedUv: boolean;
  /** Sun shadow + BRDF skipped where they add exactly 0 (exact). */
  sunSkip: boolean;
  /** No multiple-scattering compensation on the sun (near-exact). */
  noDirectMs: boolean;
  /** PCF Vogel disk rotated with one cos / sin pair (near-exact). */
  pcfRotate: boolean;
}

/** The exact set (pixel-identical): the default. */
export const MAP_SHADER_EXACT: Readonly<MapShaderOptions> = Object.freeze({
  noIbl: true,
  dielectric: true,
  sharedUv: true,
  sunSkip: true,
  noDirectMs: false,
  pcfRotate: false,
});

/** Exact + near-exact (`?diag=mapshaderfast`). */
export const MAP_SHADER_FAST: Readonly<MapShaderOptions> = Object.freeze({
  noIbl: true,
  dielectric: true,
  sharedUv: true,
  sunSkip: true,
  noDirectMs: true,
  pcfRotate: true,
});

/**
 * Options of this session from the `?diag=` experiments (ui/perfDiag.ts):
 * `nomapshader` → null (three's stock shader), `mapshaderfast` → exact +
 * near-exact, otherwise the exact set.
 */
export function mapShaderOptionsFor(experiments: ReadonlySet<string>): Readonly<MapShaderOptions> | null {
  if (experiments.has("nomapshader")) return null;
  if (experiments.has("mapshaderfast")) return MAP_SHADER_FAST;
  return MAP_SHADER_EXACT;
}

/** Short stable key of an option set (program cache key, logs). */
export function mapShaderKey(o: Readonly<MapShaderOptions>): string {
  return [
    o.noIbl ? "ibl0" : "",
    o.dielectric ? "die" : "",
    o.sharedUv ? "uv1" : "",
    o.sunSkip ? "sun0" : "",
    o.noDirectMs ? "ms0" : "",
    o.pcfRotate ? "pcfR" : "",
  ]
    .filter(Boolean)
    .join(",");
}

// ---------------------------------------------------------------------------
// Eligibility on the real data
// ---------------------------------------------------------------------------

type MapMaterial = THREE.MeshStandardMaterial & { isMapUberMaterial?: boolean };

/** Maximum |value| of a (scalar) attribute over every vertex. */
function maxAbs(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined): number {
  if (!attribute) return Infinity;
  let max = 0;
  for (let i = 0; i < attribute.count; i++) {
    const v = Math.abs(attribute.getX(i));
    if (!(v <= max)) max = v; // NaN → NaN: never eligible
  }
  return max;
}

/** Same channel and same transform: both lightmaps read the same coordinates. */
function sameUvTransform(a: THREE.Texture, b: THREE.Texture): boolean {
  if (a.channel !== b.channel) return false;
  a.updateMatrix();
  b.updateMatrix();
  return a.matrix.equals(b.matrix);
}

/**
 * Which options may apply to `material` drawn with `geometries` — each one is
 * only exact under its condition, checked here on the real values:
 *  - every option: a MeshStandardMaterial (Physical included) without normal /
 *    bump / clearcoat / sheen / iridescence / transmission / anisotropy (the
 *    rewritten chunks assume the base model);
 *  - noIbl: no env map on the material (a scene environment keeps the term
 *    through `#ifndef USE_ENVMAP` in the shader);
 *  - dielectric: metalness × aMetalness = 0 on every vertex, no metalness map;
 *  - sharedUv: emissive + AO maps on the same channel with equal transforms;
 *  - sunSkip: the base model (nothing but the direct term depends on the
 *    sun's irradiance — no sheen / clearcoat, excluded above);
 *  - noDirectMs: dielectric (the bound assumes F0 ≤ 0.04, F90 ≤ 1).
 */
export function mapShaderEligibility(
  material: THREE.Material,
  geometries: readonly THREE.BufferGeometry[],
): MapShaderOptions {
  const none: MapShaderOptions = { noIbl: false, dielectric: false, sharedUv: false, sunSkip: false, noDirectMs: false, pcfRotate: false };
  const m = material as MapMaterial & Partial<THREE.MeshPhysicalMaterial>;
  if (!m.isMeshStandardMaterial || geometries.length === 0) return none;
  if (m.normalMap || m.bumpMap || m.displacementMap || m.wireframe || m.flatShading) return none;
  if ((m.clearcoat ?? 0) > 0 || (m.sheen ?? 0) > 0 || (m.iridescence ?? 0) > 0) return none;
  if ((m.transmission ?? 0) > 0 || (m.anisotropy ?? 0) > 0 || (m.dispersion ?? 0) > 0) return none;
  const uber = m.isMapUberMaterial === true;
  let dielectric = !m.metalnessMap && m.metalness === 0;
  if (!m.metalnessMap && uber) {
    // MapUberMaterial: metalnessFactor = metalness × aMetalness.
    dielectric = m.metalness === 0 || geometries.every((g) => maxAbs(g.getAttribute("aMetalness")) === 0);
  }
  return {
    noIbl: !m.envMap,
    dielectric,
    sharedUv: !!m.emissiveMap && !!m.aoMap && sameUvTransform(m.emissiveMap, m.aoMap),
    sunSkip: true,
    noDirectMs: dielectric,
    pcfRotate: true,
  };
}

/** `wanted` restricted to what `allowed` permits (a missing option = off). */
export function restrictOptions(wanted: Readonly<Partial<MapShaderOptions>>, allowed: Readonly<MapShaderOptions>): MapShaderOptions {
  return {
    noIbl: !!wanted.noIbl && allowed.noIbl,
    dielectric: !!wanted.dielectric && allowed.dielectric,
    sharedUv: !!wanted.sharedUv && allowed.sharedUv,
    sunSkip: !!wanted.sunSkip && allowed.sunSkip,
    noDirectMs: !!wanted.noDirectMs && allowed.noDirectMs,
    pcfRotate: !!wanted.pcfRotate && allowed.pcfRotate,
  };
}

/** True when at least one option is on. */
export function anyOption(o: Readonly<MapShaderOptions>): boolean {
  return o.noIbl || o.dielectric || o.sharedUv || o.sunSkip || o.noDirectMs || o.pcfRotate;
}

// ---------------------------------------------------------------------------
// GLSL rewrite (pure: unit-tested against three's own chunks)
// ---------------------------------------------------------------------------

/** `src` with the ONE occurrence of `find` replaced — throws when it is absent or repeated. */
function replaceOnce(src: string, find: string, replacement: string, what: string): string {
  const at = src.indexOf(find);
  if (at < 0) throw new Error(`GivreMapMaterial: anchor not found (${what})`);
  if (src.indexOf(find, at + find.length) >= 0) throw new Error(`GivreMapMaterial: anchor repeated (${what})`);
  return src.slice(0, at) + replacement + src.slice(at + find.length);
}

/** The 5 Vogel-disk taps of three's PCF at φ = 0: r_i (cos iθg, sin iθg), r_i = √((i + ½) / 5). */
export function vogelTaps(count = 5): [number, number][] {
  const goldenAngle = 2.399963229728653; // three's constant
  const out: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const r = Math.sqrt((i + 0.5) / count);
    const theta = i * goldenAngle;
    out.push([Math.cos(theta) * r, Math.sin(theta) * r]);
  }
  return out;
}

/** GLSL float literal (always with a decimal point / exponent). */
function glslFloat(v: number): string {
  const s = Math.fround(v).toPrecision(9);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

/**
 * three's PCF getShadow (sampler2DShadow, Vogel disk + interleaved gradient
 * noise) with the per-pixel rotation applied ONCE: cos(iθg + φ), sin(iθg + φ)
 * expanded with one cos φ / sin φ pair instead of one pair per tap.
 */
export function rotatedPcfChunk(chunk: string): string {
  const phi = "float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;";
  // The 2D getShadow is the FIRST user of phi (the point-light one follows).
  const at = chunk.indexOf(phi);
  if (at < 0) throw new Error("GivreMapMaterial: anchor not found (PCF phi)");
  const taps = vogelTaps(5);
  const decl = taps
    .map(([x, y], i) => {
      const cx = glslFloat(x);
      const cy = glslFloat(y);
      return `vec2 givreTap${i} = vec2( ${cx} * givreRot.x - ${cy} * givreRot.y, ${cx} * givreRot.y + ${cy} * givreRot.x );`;
    })
    .join("\n\t\t\t\t");
  let out =
    chunk.slice(0, at + phi.length) +
    `\n\t\t\t\tvec2 givreRot = vec2( cos( phi ), sin( phi ) );\n\t\t\t\t${decl}` +
    chunk.slice(at + phi.length);
  for (let i = 0; i < taps.length; i++) {
    out = replaceOnce(out, `vogelDiskSample( ${i}, 5, phi ) * radius`, `givreTap${i} * radius`, `PCF tap ${i}`);
  }
  return out;
}

/** `src` with every occurrence of `find` replaced — throws unless there are exactly `count`. */
function replaceCount(src: string, find: string, replacement: string, count: number, what: string): string {
  const parts = src.split(find);
  if (parts.length - 1 !== count) throw new Error(`GivreMapMaterial: ${parts.length - 1} × anchor, ${count} expected (${what})`);
  return parts.join(replacement);
}

/**
 * three's directional-light loop (lights_fragment_begin) with the sun's work
 * done only where it can add light. RE_Direct adds irradiance × BRDF with
 * irradiance = saturate(N·L) × colour × shadow: exactly 0 when N·L ≤ 0 (then
 * neither the shadow lookup nor the BRDF is needed) or when the shadow
 * factor is exactly 0 (every PCF tap occluded: no BRDF).
 */
export function sunSkipLightsChunk(chunk: string): string {
  const info = "getDirectionalLightInfo( directionalLight, directLight );";
  const direct = "RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );";
  const at = chunk.indexOf(info);
  if (at < 0 || chunk.indexOf(info, at + 1) >= 0) throw new Error("GivreMapMaterial: anchor not found (directional light info)");
  const end = chunk.indexOf(direct, at);
  if (end < 0) throw new Error("GivreMapMaterial: anchor not found (directional RE_Direct)");
  return (
    chunk.slice(0, at + info.length) +
    "\n\n\t\tif ( dot( geometryNormal, directLight.direction ) > 0.0 ) {" +
    chunk.slice(at + info.length, end) +
    `if ( directLight.color != vec3( 0.0 ) ) ${direct}\n\n\t\t}` +
    chunk.slice(end + direct.length)
  );
}

/**
 * The 5 taps of the 2D PCF getShadow with an explicit LOD 0 (they sit in a
 * branch with sunSkip: no implicit derivatives there). The shadow map has a
 * single level and the same filter both ways: the same texels and weights.
 */
export function explicitLodPcfChunk(chunk: string): string {
  let out = replaceCount(chunk, "texture( shadowMap, vec3( shadowCoord.xy + ", "textureLod( shadowMap, vec3( shadowCoord.xy + ", 5, "PCF taps");
  out = replaceCount(out, " * radius, shadowCoord.z ) )", " * radius, shadowCoord.z ), 0.0 )", 5, "PCF tap ends");
  return out;
}

/** The pieces of three's library the rewrite uses (injected: unit tests pass the same objects). */
export interface ShaderChunks {
  lights_physical_pars_fragment: string;
  lights_fragment_begin: string;
  shadowmap_pars_fragment: string;
  aomap_fragment: string;
}

/**
 * Rewrites a MeshStandardMaterial program (as onBeforeCompile receives it:
 * `#include` lines still unresolved, after MapUberMaterial's own patch when
 * `uber`) for the options. Throws when an anchor is missing (three upgrade):
 * the caller then keeps the stock shader.
 */
export function specialiseMapShader(
  shader: { vertexShader: string; fragmentShader: string },
  o: Readonly<MapShaderOptions>,
  uber: boolean,
  chunks: ShaderChunks = THREE.ShaderChunk as unknown as ShaderChunks,
): void {
  let vs = shader.vertexShader;
  let fs = shader.fragmentShader;

  if (o.noIbl || o.noDirectMs || o.sunSkip) {
    let pars = chunks.lights_physical_pars_fragment;
    if (o.noDirectMs) {
      pars = replaceOnce(
        pars,
        "irradiance * BRDF_GGX_Multiscatter( directLight.direction, geometryViewDir, geometryNormal, material )",
        "irradiance * BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material )",
        "direct multiscatter",
      );
    } else if (o.sunSkip) {
      // The sun's DFG lookups now run in a branch: explicit LOD 0 (the LUT
      // has one level, linear both ways — the same value).
      pars = replaceOnce(
        pars,
        "vec2 dfgV = texture2D( dfgLUT, vec2( material.roughness, dotNV ) ).rg;",
        "vec2 dfgV = textureLod( dfgLUT, vec2( material.roughness, dotNV ), 0.0 ).rg;",
        "direct DFG (V)",
      );
      pars = replaceOnce(
        pars,
        "vec2 dfgL = texture2D( dfgLUT, vec2( material.roughness, dotNL ) ).rg;",
        "vec2 dfgL = textureLod( dfgLUT, vec2( material.roughness, dotNL ), 0.0 ).rg;",
        "direct DFG (L)",
      );
    }
    if (o.noIbl) {
      // radiance = iblIrradiance = 0 without an env map: the term adds 0.
      pars = replaceOnce(
        pars,
        "#define RE_IndirectSpecular\t\tRE_IndirectSpecular_Physical",
        "#ifdef USE_ENVMAP\n#define RE_IndirectSpecular\t\tRE_IndirectSpecular_Physical\n#endif",
        "RE_IndirectSpecular",
      );
    }
    fs = replaceOnce(fs, "#include <lights_physical_pars_fragment>", pars, "lights_physical_pars_fragment include");
  }

  if (o.dielectric) {
    if (uber) {
      vs = replaceOnce(vs, "attribute float aMetalness;\n", "", "uber aMetalness");
      vs = replaceOnce(vs, "\nvarying float vUberMetalness;", "", "uber vUberMetalness (vs)");
      vs = replaceOnce(vs, "\n\tvUberMetalness = aMetalness;", "", "uber vUberMetalness write");
      fs = replaceOnce(fs, "\nvarying float vUberMetalness;", "", "uber vUberMetalness (fs)");
      fs = replaceOnce(fs, "float metalnessFactor = metalness * vUberMetalness;", "const float metalnessFactor = 0.0;", "uber metalness");
    } else {
      fs = replaceOnce(fs, "#include <metalnessmap_fragment>", "const float metalnessFactor = 0.0;", "metalnessmap_fragment");
    }
  }

  if (o.sharedUv) {
    // The AO map reads the emissive map's coordinates (same uv, same
    // transform): no vAoMapUv varying. USE_AOMAP stays defined for the AO
    // code itself (aoMapIntensity, sampler); the vertex shader only uses it
    // for that varying.
    vs = replaceOnce(vs, "#include <uv_pars_vertex>", "#undef USE_AOMAP\n#include <uv_pars_vertex>", "uv_pars_vertex");
    fs = replaceOnce(
      fs,
      "#include <uv_pars_fragment>",
      "#ifdef USE_AOMAP\n#undef USE_AOMAP\n#include <uv_pars_fragment>\n#define USE_AOMAP\n#else\n#include <uv_pars_fragment>\n#endif",
      "uv_pars_fragment",
    );
    const ao = replaceOnce(chunks.aomap_fragment, "texture2D( aoMap, vAoMapUv )", "texture2D( aoMap, vEmissiveMapUv )", "aomap uv");
    fs = replaceOnce(fs, "#include <aomap_fragment>", ao, "aomap_fragment include");
  }

  if (o.sunSkip) {
    fs = replaceOnce(fs, "#include <lights_fragment_begin>", sunSkipLightsChunk(chunks.lights_fragment_begin), "lights_fragment_begin include");
  }

  if (o.pcfRotate || o.sunSkip) {
    let shadow = chunks.shadowmap_pars_fragment;
    if (o.pcfRotate) shadow = rotatedPcfChunk(shadow);
    if (o.sunSkip) shadow = explicitLodPcfChunk(shadow);
    fs = replaceOnce(fs, "#include <shadowmap_pars_fragment>", shadow, "shadowmap_pars_fragment include");
  }

  shader.vertexShader = vs;
  shader.fragmentShader = fs;
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

/** Extra patch applied after the specialisation (DEV bench variants only). */
export type ShaderPatch = (shader: THREE.WebGLProgramParametersWithUniforms) => void;

/**
 * The specialised CLONE of a map material (same name, values, maps, sides,
 * stencil — Material.copy), or null when no option applies to it. The clone
 * keeps the source's own patch (MapUberMaterial) and runs the rewrite after
 * it; its program cache key names the options. If the rewrite fails (a three
 * upgrade moved an anchor) the stock shader is kept, with a warning.
 */
export function createMapShaderMaterial(
  source: THREE.Material,
  geometries: readonly THREE.BufferGeometry[],
  wanted: Readonly<MapShaderOptions>,
  extra?: { key: string; patch: ShaderPatch },
): THREE.Material | null {
  const options = restrictOptions(wanted, mapShaderEligibility(source, geometries));
  if (!anyOption(options) && !extra) return null;
  const uber = (source as MapMaterial).isMapUberMaterial === true;
  const material = source.clone();
  material.name = source.name;
  material.userData = { ...source.userData, mapShader: mapShaderKey(options) };
  const base = material.onBeforeCompile;
  const baseKey = source.customProgramCacheKey();
  const key = `${baseKey}|givre-map-shader-v1:${mapShaderKey(options)}${extra ? `|${extra.key}` : ""}`;
  material.onBeforeCompile = (shader, renderer) => {
    base.call(material, shader, renderer);
    try {
      const copy = { vertexShader: shader.vertexShader, fragmentShader: shader.fragmentShader };
      specialiseMapShader(copy, options, uber);
      shader.vertexShader = copy.vertexShader;
      shader.fragmentShader = copy.fragmentShader;
    } catch (err) {
      console.warn(`GivreMapMaterial: stock shader kept for ${source.name} — ${String(err)}`);
    }
    extra?.patch(shader);
  };
  material.customProgramCacheKey = () => key;
  return material;
}

/** One map mesh whose material can be specialised, with its stock material. */
export interface MapShaderTarget {
  mesh: THREE.Mesh;
  stock: THREE.Material;
}

/**
 * The DRAWN meshes of the map (own `visible` flag: the hidden sources of the
 * batches and instanced puffs stay as they are) whose single material is an
 * opaque MeshStandardMaterial the rewrite understands. `exclude`: material
 * names never swapped (GIV_Feu's emissive flickers through the shared
 * instance — GivreEffects).
 */
export function collectMapShaderTargets(roots: readonly THREE.Object3D[], exclude: ReadonlySet<string>): MapShaderTarget[] {
  const out: MapShaderTarget[] = [];
  for (const root of roots) {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible || Array.isArray(mesh.material)) return;
      const m = mesh.material as THREE.MeshStandardMaterial;
      if (!m.isMeshStandardMaterial || m.transparent || exclude.has(m.name)) return;
      out.push({ mesh, stock: m });
    });
  }
  return out;
}

/**
 * Swaps every target to its specialised material for `options` (null = the
 * stock materials). One clone per stock material and option set, cached in
 * `cache`; geometries of all the meshes sharing a material are checked
 * together. Returns the number of meshes drawn with a specialised material.
 */
export function applyMapShader(
  targets: readonly MapShaderTarget[],
  options: Readonly<MapShaderOptions> | null,
  cache: Map<string, THREE.Material | null>,
  extra?: { key: string; patch: ShaderPatch },
): number {
  const byStock = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const t of targets) {
    const list = byStock.get(t.stock) ?? [];
    list.push(t.mesh.geometry);
    byStock.set(t.stock, list);
  }
  let swapped = 0;
  for (const t of targets) {
    if (!options) {
      t.mesh.material = t.stock;
      continue;
    }
    const cacheKey = `${t.stock.uuid}|${mapShaderKey(options)}|${extra?.key ?? ""}`;
    let material = cache.get(cacheKey);
    if (material === undefined) {
      material = createMapShaderMaterial(t.stock, byStock.get(t.stock)!, options, extra);
      cache.set(cacheKey, material);
    }
    t.mesh.material = material ?? t.stock;
    if (material) swapped++;
  }
  return swapped;
}
