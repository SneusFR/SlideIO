import * as THREE from "three";
import { GLTFLoader, GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
// Common Potato first-person arms (mesh + skeleton, NO animations) —
// loaded exactly once; ONE instance exists for the local player.
// The exported FP_Viewmodel container already carries the camera-space
// conversion (+X right, +Y up, -Z forward): no extra 180° rotation and
// no authored vertical offset may be re-applied here.
import fpArmsUrl from "../../assets/potato/Potato_FP_CommonArms.glb?url";

let armsPromise: Promise<GLTF> | null = null;

/** Load + cache the shared FP arms GLB exactly once. */
export function loadFPArmsGltf(): Promise<GLTF> {
  if (armsPromise) return armsPromise;
  armsPromise = new GLTFLoader().loadAsync(fpArmsUrl);
  return armsPromise;
}

// Per-URL cache of FP pose libraries (clips only — their scene graphs are
// NEVER rendered; adding one would create a second skeleton).
const poseLibraryCache = new Map<string, Promise<THREE.AnimationClip[]>>();

/** Load + cache a FP pose library's clips (gltf.animations only). */
export function loadFPPoseClips(url: string): Promise<THREE.AnimationClip[]> {
  let cached = poseLibraryCache.get(url);
  if (cached) return cached;
  cached = new GLTFLoader().loadAsync(url).then((gltf) => gltf.animations);
  poseLibraryCache.set(url, cached);
  return cached;
}
