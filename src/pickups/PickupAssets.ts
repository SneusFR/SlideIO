import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PickupConfig as pc } from "./PickupConfig";
import medkitUrl from "../assets/medkit_opt.glb?url";
import coinUrl from "../assets/coin_opt.glb?url";

/**
 * GLB templates for the loot pickups.
 *
 * Each model is fetched + parsed EXACTLY ONCE (same pipeline as the
 * weapon viewmodels: optimized *_opt.glb + GLTFLoader). Every drop in
 * the world is a cheap `clone()` of the prepared template — geometry
 * and materials are shared between all instances, nothing is ever
 * re-downloaded or re-parsed on a kill.
 */
export class PickupAssets {
  medkitTemplate: THREE.Group | null = null;
  coinTemplate: THREE.Group | null = null;

  private started = false;

  /** Kick the one-time loads (call once at game startup). */
  load(): void {
    if (this.started) return;
    this.started = true;
    const loader = new GLTFLoader();
    loader.load(
      medkitUrl,
      (gltf) => {
        this.medkitTemplate = normalizeTemplate(gltf.scene, pc.medkitSize);
      },
      undefined,
      (err) => console.warn("[pickups] medkit GLB failed to load", err),
    );
    loader.load(
      coinUrl,
      (gltf) => {
        this.coinTemplate = normalizeTemplate(gltf.scene, pc.coinSize);
      },
      undefined,
      (err) => console.warn("[pickups] coin GLB failed to load", err),
    );
  }
}

/**
 * Scale the raw model to the target gameplay size and center it at the
 * origin so pickups can position/rotate it trivially. Done once per GLB.
 */
function normalizeTemplate(model: THREE.Group, targetSize: number): THREE.Group {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1e-6);
  model.scale.setScalar(targetSize / maxDim);

  box.setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  model.position.sub(center);

  model.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // Shared materials: mark them so per-bot dispose logic elsewhere
      // never destroys them by accident.
      const mat = mesh.material as THREE.Material;
      if (mat) mat.userData.shared = true;
    }
  });

  const wrapper = new THREE.Group();
  wrapper.add(model);
  return wrapper;
}