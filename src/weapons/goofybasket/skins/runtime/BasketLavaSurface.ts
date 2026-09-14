import * as THREE from 'three';

export interface BasketLavaSurface {
  /** Absolute elapsed time; charge is cosmetic and clamped to 0..1. */
  update(time: number, charge: number): void;
}

interface Binding {
  handle: BasketLavaSurface;
  uniforms: {
    uBasketLavaTime: { value: number };
    uBasketLavaCharge: { value: number };
    uBasketLavaSeed: { value: number };
    uBasketLavaRadius: { value: number };
  };
}

const bindings = new WeakMap<THREE.MeshStandardMaterial, Binding>();
const CACHE_KEY = 'goofybasket-lava-surface-v1';

const vertexHeader = /* glsl */`
uniform float uBasketLavaRadius;
varying vec3 vBasketLavaPosition;
`;

const fragmentHeader = /* glsl */`
uniform float uBasketLavaTime;
uniform float uBasketLavaCharge;
uniform float uBasketLavaSeed;
varying vec3 vBasketLavaPosition;

float gbLavaHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float gbLavaNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(gbLavaHash(i), gbLavaHash(i + vec3(1,0,0)), f.x),
        mix(gbLavaHash(i + vec3(0,1,0)), gbLavaHash(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(gbLavaHash(i + vec3(0,0,1)), gbLavaHash(i + vec3(1,0,1)), f.x),
        mix(gbLavaHash(i + vec3(0,1,1)), gbLavaHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
`;

// The map and its UVs stay fixed. Only the heat field travels through its cracks.
const fragmentFlow = /* glsl */`
#ifdef USE_EMISSIVEMAP
  float gbCrack = smoothstep(0.008, 0.18,
    max(emissiveColor.r, max(emissiveColor.g, emissiveColor.b)));
  vec3 gbP = vBasketLavaPosition;
  vec3 gbSeed = vec3(uBasketLavaSeed, uBasketLavaSeed * 0.731, uBasketLavaSeed * 1.173);
  float gbT = uBasketLavaTime * 0.44;
  vec3 gbFlow = vec3(-0.43, 0.81, 0.32) * gbT;
  float gbCoarse = gbLavaNoise(gbP * 3.4 + gbSeed + gbFlow);
  float gbFine = gbLavaNoise(gbP * 8.0 + gbSeed * 0.61
    + gbFlow * 1.38 + vec3(gbCoarse * 1.6));
  float gbHeat = smoothstep(0.24, 0.74, gbCoarse * 0.76 + gbFine * 0.24);
  gbHeat = min(1.0, gbHeat + uBasketLavaCharge * 0.13);
  float gbHot = smoothstep(0.56, 0.96, gbHeat);
  // Moderate linear RGB retains orange/gold under ACES; no white strobe.
  vec3 gbColor = mix(vec3(0.16, 0.006, 0.0002), vec3(1.05, 0.16, 0.002), gbHeat);
  gbColor = mix(gbColor, vec3(1.65, 0.42, 0.009), gbHot);
  float gbStrength = clamp(max(emissive.r, max(emissive.g, emissive.b)), 0.0, 2.2);
  vec3 gbRadiance = gbColor * gbStrength * (1.0 + uBasketLavaCharge * 0.22);
  totalEmissiveRadiance = mix(totalEmissiveRadiance, gbRadiance, gbCrack);
  // Prevent the painted bright cracks from washing out the moving cool pockets.
  // Unmasked basalt retains its original base color, roughness and lighting.
  diffuseColor.rgb *= mix(1.0, 0.22 + gbHeat * 0.65, gbCrack);
#endif
`;

/**
 * Adds moving lava to an existing, instance-owned PBR panel material.
 * Call for both panel clones with the same seed/radius/time for seamless flow.
 * localRadius is the raw geometry radius, before any node/world scale (.125).
 * No textures, geometry, renderer or GPU resources are created or owned here.
 * The caller owns and disposes the material as usual. Attach again after clone().
 */
export function attachBasketLavaSurface(
  material: THREE.MeshStandardMaterial,
  seed: number,
  localRadius = 0.125,
): BasketLavaSurface {
  if (!material.isMeshStandardMaterial) throw new Error('Basket lava requires a MeshStandardMaterial.');
  if (!Number.isFinite(localRadius) || localRadius <= 0) throw new Error('Basket lava localRadius must be positive and finite.');
  const phase = Number.isFinite(seed) ? ((seed % 1024) + 1024) % 1024 : 0;
  const existing = bindings.get(material);
  if (existing) {
    existing.uniforms.uBasketLavaSeed.value = phase;
    existing.uniforms.uBasketLavaRadius.value = localRadius;
    return existing.handle;
  }

  const uniforms: Binding['uniforms'] = {
    uBasketLavaTime: { value: 0 },
    uBasketLavaCharge: { value: 0 },
    uBasketLavaSeed: { value: phase },
    uBasketLavaRadius: { value: localRadius },
  };
  const previousCompile = material.onBeforeCompile;
  // Capture before patching: Three's default key uses onBeforeCompile.toString().
  // Instance values belong in uniforms, never in the shared program cache key.
  const previousKey = material.customProgramCacheKey();
  material.customProgramCacheKey = () => `${previousKey}|${CACHE_KEY}`;
  material.onBeforeCompile = function (shader, renderer) {
    previousCompile.call(this, shader, renderer);
    if (!shader.vertexShader.includes('#include <begin_vertex>')
      || !shader.fragmentShader.includes('#include <emissivemap_fragment>')) {
      throw new Error('Basket lava shader markers are missing; verify the Three.js shader version or earlier material hooks.');
    }
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = vertexHeader + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\nvBasketLavaPosition = position / uBasketLavaRadius;',
    );
    shader.fragmentShader = fragmentHeader + shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n' + fragmentFlow,
    );
  };

  const handle: BasketLavaSurface = {
    update(time, charge) {
      if (Number.isFinite(time)) uniforms.uBasketLavaTime.value = time;
      uniforms.uBasketLavaCharge.value = Number.isFinite(charge)
        ? THREE.MathUtils.clamp(charge, 0, 1) : 0;
    },
  };
  bindings.set(material, { handle, uniforms });
  material.needsUpdate = true;
  return handle;
}
