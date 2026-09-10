import * as THREE from "three";
import { GLTFLoader, GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { markEnemyOutlineOccluder } from "../../characters/PotatoCharacter";
import { BrickMaulProfile } from "./BrickMaulProfile";

/**
 * Shared, cached Brick Maul assets:
 *   - the weapon GLB (skinned scene with the Pupil_L / Pupil_R bones),
 *     loaded exactly ONCE; every FP/TP instance is a SkeletonUtils clone
 *     (geometry + materials SHARED — detaching an instance never disposes
 *     a common resource);
 *   - the TP pose library (clips only — its scene is never rendered).
 * The FP pose library goes through FPArmsRig.loadFPPoseClips (same cache
 * policy as the HexSniper).
 */

let weaponPromise: Promise<GLTF> | null = null;
let tpClipsPromise: Promise<THREE.AnimationClip[]> | null = null;

/** Load + cache the Brick Maul weapon GLB exactly once. */
export function loadBrickMaulGltf(): Promise<GLTF> {
  if (weaponPromise) return weaponPromise;
  weaponPromise = new GLTFLoader().loadAsync(BrickMaulProfile.weaponUrl).then((gltf) => {
    // In-hand weapons mask the red enemy contour (stencil ref 1) like every
    // other held weapon — the materials are shared, one marking is enough.
    markEnemyOutlineOccluder(gltf.scene);
    return gltf;
  });
  return weaponPromise;
}

/** Load + cache the TP pose library clips (gltf.animations only). */
export function loadBrickMaulTPClips(): Promise<THREE.AnimationClip[]> {
  if (tpClipsPromise) return tpClipsPromise;
  const url = BrickMaulProfile.tpPosesUrl!;
  tpClipsPromise = new GLTFLoader().loadAsync(url).then((gltf) => gltf.animations);
  return tpClipsPromise;
}

/**
 * New rendered instance of the COMPLETE weapon scene (skeleton cloned, the
 * Pupil bones' full graph preserved). No normalization, no recentering, no
 * scale multiplier: the profile mount matrix already carries the scale.
 */
export function instantiateBrickMaul(gltf: GLTF): THREE.Object3D {
  const weapon = skeletonClone(gltf.scene);
  weapon.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false; // moves with an animated bone
      mesh.raycast = () => {}; // visual only — never a gameplay target
    }
  });
  return weapon;
}
