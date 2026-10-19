import * as THREE from "three";
import { BATCHED_SOURCE_LAYER, isRigidPartsBatch } from "./RigidPartsBatch";

/**
 * PERF — transparent DOUBLE-SIDED parts (tank / hopper glass) are drawn by
 * three.js in two passes, back faces then front faces, flagging the material
 * `needsUpdate` before each pass: a full program re-selection twice per part
 * and per frame. The same two passes as two meshes with a fixed side each
 * (shared geometry, cached BackSide / FrontSide clones of the material): the
 * back one is created first, so at equal depth it still sorts first — same
 * blending order, same image, no re-selection. The source mesh stays in the
 * graph (controllers keep toggling it; dropped copies reuse its material)
 * but moves to a layer no camera renders; its `visible` still hides both.
 *
 * Used by the third-person weapons (RemoteWeaponController) and by the
 * first-person viewmodels (FP pass) — call once the meshes' materials and
 * render orders are final.
 */
const sideClones = new WeakMap<THREE.Material, { back: THREE.Material; front: THREE.Material }>();

export function splitTwoPassTransparents(root: THREE.Object3D): void {
  const targets: THREE.Mesh[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material) || !mesh.layers.isEnabled(0)) return;
    if ((mesh as THREE.InstancedMesh).isInstancedMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
    if (isRigidPartsBatch(mesh) || mesh.userData.twoPassSplit) return;
    const m = mesh.material;
    if (!m.transparent || m.side !== THREE.DoubleSide || m.forceSinglePass) return;
    if (mesh.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender) return;
    targets.push(mesh);
  });
  for (const mesh of targets) {
    const source = mesh.material as THREE.Material;
    let pair = sideClones.get(source);
    if (!pair) {
      const sided = (side: THREE.Side) => {
        const clone = source.clone();
        clone.side = side;
        // Material.copy never copies the shader hooks.
        clone.onBeforeCompile = source.onBeforeCompile;
        clone.customProgramCacheKey = source.customProgramCacheKey;
        return clone;
      };
      pair = { back: sided(THREE.BackSide), front: sided(THREE.FrontSide) };
      sideClones.set(source, pair);
    }
    for (const material of [pair.back, pair.front]) {
      const pass = new THREE.Mesh(mesh.geometry, material);
      pass.name = `${mesh.name}_${material === pair.back ? "back" : "front"}`;
      pass.renderOrder = mesh.renderOrder;
      pass.castShadow = false;
      pass.receiveShadow = mesh.receiveShadow;
      pass.frustumCulled = mesh.frustumCulled;
      pass.matrixAutoUpdate = false; // identity under the source
      pass.raycast = () => {};
      pass.userData.noOutline = mesh.userData.noOutline === true;
      pass.userData.twoPassSplit = true;
      mesh.add(pass);
    }
    mesh.userData.twoPassSplit = true;
    mesh.layers.set(BATCHED_SOURCE_LAYER);
  }
}
