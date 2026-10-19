import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import lanceUrl from "../assets/lance_opt.glb?url";

/**
 * The Astral Lance GLB (13 MB: 128k triangles, three 2048² JPEG maps),
 * fetched and parsed ONCE for the whole game.
 *
 * PERF (loading): the FP viewmodel and the third-person template (bots /
 * remote players) used to load it each on its own — two parses, six JPEG
 * decodes, six 2048² textures uploaded by the GPU warm-up. Both now take a
 * copy of this one: own node tree and own materials (each tunes them its own
 * way — FP draws over the world, TP masks the enemy outline), the same
 * geometry and textures. The cached original is never displayed.
 */
let lancePromise: Promise<GLTF> | null = null;

export function loadLanceGltf(): Promise<GLTF> {
  lancePromise ??= new GLTFLoader().loadAsync(lanceUrl);
  return lancePromise;
}

/** A copy of the lance for one user: own nodes + own materials, shared geometry / textures. */
export async function instantiateLance(): Promise<THREE.Group> {
  const gltf = await loadLanceGltf();
  const copy = gltf.scene.clone(true);
  copy.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => m.clone()) : mesh.material.clone();
  });
  return copy;
}
