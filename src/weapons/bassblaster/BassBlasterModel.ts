import { GLTFLoader, GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import pulseCarbineUrl from "../../assets/PulseCarbine/PulseCarbine.glb?url";

/**
 * Shared, cached PulseCarbine GLB (the Bass Blaster's model — see
 * src/assets/PulseCarbine/README_FR.md):
 *   - the DETAILED asset (PulseCarbine.glb, 17.3k tris, 2×256px embedded
 *     textures, 5 shared PBR materials) is loaded exactly ONCE
 *     (module-level promise cache);
 *   - every consumer builds a PulseCarbineController from this GLTF —
 *     the controller SkeletonUtils-clones the scene, so geometry,
 *     materials and textures stay SHARED between instances;
 *   - the LOD (PulseCarbine_LOD1.glb) is used by the remote-player and
 *     menu-icon pipelines (weapons seen at distance / snapshots).
 *
 * Conventions of the asset: authored in METERS, muzzle facing -X, with
 * Muzzle / GripSocket / OffhandSocket / StockSocket attachment empties
 * and the animation clips Idle / Fire / Fire_AltA / Fire_AltB / MusicLoop
 * (driven exclusively by PulseCarbineController — never add a second
 * mixer on the same objects).
 */

let gltfPromise: Promise<GLTF> | null = null;

/** Load + parse the PulseCarbine GLB exactly once (clones are cheap). */
export function loadPulseCarbineGltf(): Promise<GLTF> {
  if (!gltfPromise) {
    gltfPromise = new GLTFLoader().loadAsync(pulseCarbineUrl);
  }
  return gltfPromise;
}
