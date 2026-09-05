import { GLTFLoader, GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { getQualitySettings } from "../../game/GraphicsQuality";
import hexSniperUrl from "../../assets/HexSniper/HexSniper.glb?url";
import hexSniperLod1Url from "../../assets/HexSniper/HexSniper_LOD1.glb?url";

/**
 * Shared, cached HexSniper GLB — same pipeline as every other weapon model:
 *   - loaded exactly ONCE (module-level promise cache);
 *   - the quality preset picks the variant: LOW → HexSniper_LOD1.glb
 *     (7 380 tris), HIGH → HexSniper.glb (14 630 tris). Both keep the same
 *     clips / bones / meshes / sockets (kit contract);
 *   - every consumer clones through HexSniperController (SkeletonUtils),
 *     so geometries and materials are SHARED between instances.
 *
 * The remote in-hand model (RemoteWeaponController) always uses LOD1 —
 * distant weapons never need the detailed head.
 */

let gltfPromise: Promise<GLTF> | null = null;

/** Load + cache the HexSniper GLB exactly once (quality-appropriate LOD). */
export function loadHexSniperGltf(): Promise<GLTF> {
  if (gltfPromise) return gltfPromise;
  const url = getQualitySettings().level === "LOW" ? hexSniperLod1Url : hexSniperUrl;
  gltfPromise = new GLTFLoader().loadAsync(url);
  return gltfPromise;
}
