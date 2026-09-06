import { GLTFLoader, GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import hexSniperUrl from "../../assets/potato/HexSniper_Weapon.glb?url";

/**
 * Shared, cached HexSniper GLB (integration pack canonical asset:
 * src/assets/potato/HexSniper_Weapon.glb — full weapon, embedded
 * materials/textures, own 8-bone skeleton, 7 internal animations
 * including Inspect_Affection):
 *   - loaded exactly ONCE (module-level promise cache);
 *   - every consumer clones through HexSniperController (SkeletonUtils),
 *     so geometries and materials are SHARED between instances.
 *
 * PERF NOTE (known limitation): no LOD variant of this pack exists yet —
 * HIGH and LOW quality presets both use this canonical GLB. The legacy
 * HexSniper_LOD1 did NOT contain Inspect_Affection and is not
 * interchangeable without validation; a future compatible LOD can plug
 * back in here (make the quality level part of the cache key then).
 */

let gltfPromise: Promise<GLTF> | null = null;

/** Load + cache the HexSniper weapon GLB exactly once. */
export function loadHexSniperGltf(): Promise<GLTF> {
  if (gltfPromise) return gltfPromise;
  gltfPromise = new GLTFLoader().loadAsync(hexSniperUrl);
  return gltfPromise;
}
