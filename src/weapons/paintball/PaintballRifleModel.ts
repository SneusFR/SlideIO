import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PaintballRifleProfile } from "../profiles/PaintballRifleProfile";
import { markEnemyOutlineOccluder } from "../../characters/PotatoCharacter";
import { paintPaletteLinear } from "./PaintJetSettings";

/**
 * Shared, cached Paintball Rifle assets (same pattern as PopcornShotgunModel):
 *   - the weapon GLB, loaded exactly ONCE and shared by the local FP
 *     controller, every remote TP controller and the visual ball pool
 *     (each controller clones the scene — geometry / materials stay shared);
 *   - the TP pose library clips (gltf.animations only — never its scene).
 * The FP pose library goes through FPArmsRig.loadFPPoseClips.
 */

let weaponPromise: Promise<GLTF> | null = null;
let tpClipsPromise: Promise<THREE.AnimationClip[]> | null = null;

/** Load + cache the weapon GLB exactly once (FP + TP share it). */
export function loadPaintballRifleGltf(): Promise<GLTF> {
  if (weaponPromise) return weaponPromise;
  weaponPromise = new GLTFLoader().loadAsync(PaintballRifleProfile.weaponUrl).then((gltf) => {
    // Held by enemy avatars: the weapon masks the red contour like every
    // in-hand weapon (pure GL stencil state — no effect in the FP pass).
    markEnemyOutlineOccluder(gltf.scene);
    // Paint palette = pink / blue / yellow (index = the `pc` sent on the wire).
    // Patched BEFORE any clone: the hopper balls, the shot colour and the jets
    // all read this palette, so they always match.
    const hopper = gltf.scene.getObjectByName("Hopper");
    if (hopper) hopper.userData.palette = paintPaletteLinear();
    return gltf;
  });
  return weaponPromise;
}

/** Load + cache the TP pose library clips (gltf.animations only). */
export function loadPaintballRifleTPClips(): Promise<THREE.AnimationClip[]> {
  if (tpClipsPromise) return tpClipsPromise;
  tpClipsPromise = new GLTFLoader().loadAsync(PaintballRifleProfile.tpPosesUrl!).then((gltf) => gltf.animations);
  return tpClipsPromise;
}
