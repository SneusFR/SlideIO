import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { WaterFamasProfile } from "../profiles/WaterFamasProfile";
import { markEnemyOutlineOccluder } from "../../characters/PotatoCharacter";

/**
 * Shared, cached Water FAMAS assets (same pattern as PaintballRifleModel):
 *   - the weapon GLB, loaded exactly ONCE and shared by the local FP
 *     controller and every remote TP controller (each controller clones the
 *     scene — geometry / materials stay shared, the tank gets its own liquid
 *     materials);
 *   - the TP pose library clips (gltf.animations only — never its scene).
 * The FP pose library goes through FPArmsRig.loadFPPoseClips.
 */

let weaponPromise: Promise<GLTF> | null = null;
let tpClipsPromise: Promise<THREE.AnimationClip[]> | null = null;

/** Load + cache the weapon GLB exactly once (FP + TP share it). */
export function loadWaterFamasGltf(): Promise<GLTF> {
  if (weaponPromise) return weaponPromise;
  weaponPromise = new GLTFLoader().loadAsync(WaterFamasProfile.weaponUrl).then((gltf) => {
    // Held by enemy avatars: the weapon masks the red contour like every
    // in-hand weapon (pure GL stencil state — no effect in the FP pass).
    markEnemyOutlineOccluder(gltf.scene);
    return gltf;
  });
  return weaponPromise;
}

/** Load + cache the TP pose library clips (gltf.animations only). */
export function loadWaterFamasTPClips(): Promise<THREE.AnimationClip[]> {
  if (tpClipsPromise) return tpClipsPromise;
  tpClipsPromise = new GLTFLoader().loadAsync(WaterFamasProfile.tpPosesUrl!).then((gltf) => gltf.animations);
  return tpClipsPromise;
}
