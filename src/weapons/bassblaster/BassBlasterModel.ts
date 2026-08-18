import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import bassBlasterModelUrl from "../../assets/bassblaster_opt.glb?url";

/**
 * Shared, cached Bass Blaster GLB — same optimization pipeline as every
 * other weapon model in the project:
 *   - the OPTIMIZED asset (bassblaster_opt.glb: 1024px JPEG textures +
 *     mesh simplified to ~5% of the source triangles, ~5.2 MB vs 82.5 MB
 *     source) is the only file ever loaded;
 *   - loaded exactly ONCE (module-level promise cache);
 *   - every consumer clones the normalized template — geometry and
 *     materials are SHARED between clones;
 *   - zero procedural reconstruction of the model.
 *
 * The template is normalized: barrel facing -Z, total length = 1 m,
 * centered at the origin. Consumers only scale/position their clone.
 */

let templatePromise: Promise<THREE.Group> | null = null;

/**
 * Heuristic shared with the revolver pipeline: the muzzle end has a
 * thinner cross-section than the stock/grip end. Returns +1 if the muzzle
 * sits on the positive side of `axis` ("x" or "z"), else -1.
 */
function findMuzzleSign(model: THREE.Object3D, box: THREE.Box3, axis: "x" | "z"): number {
  const min = axis === "x" ? box.min.x : box.min.z;
  const max = axis === "x" ? box.max.x : box.max.z;
  const center = (min + max) / 2;
  const half = Math.max((max - min) / 2, 1e-6);
  const pos = { minA: Infinity, maxA: -Infinity, minB: Infinity, maxB: -Infinity };
  const neg = { minA: Infinity, maxA: -Infinity, minB: Infinity, maxB: -Infinity };
  const v = new THREE.Vector3();

  model.updateMatrixWorld(true);
  model.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const attr = (obj.geometry as THREE.BufferGeometry).getAttribute("position");
    for (let i = 0; i < attr.count; i++) {
      v.fromBufferAttribute(attr as THREE.BufferAttribute, i).applyMatrix4(obj.matrixWorld);
      const along = axis === "x" ? v.x : v.z;
      const other = axis === "x" ? v.z : v.x;
      const t = (along - center) / half; // -1 .. 1 along the barrel axis
      const side = t > 0.55 ? pos : t < -0.55 ? neg : null;
      if (!side) continue;
      side.minA = Math.min(side.minA, v.y);
      side.maxA = Math.max(side.maxA, v.y);
      side.minB = Math.min(side.minB, other);
      side.maxB = Math.max(side.maxB, other);
    }
  });

  const posArea = (pos.maxA - pos.minA) * (pos.maxB - pos.minB);
  const negArea = (neg.maxA - neg.minA) * (neg.maxB - neg.minB);
  return posArea <= negArea ? 1 : -1;
}

/** Load + normalize the Bass Blaster template exactly once. */
export function loadBassBlasterTemplate(): Promise<THREE.Group> {
  if (templatePromise) return templatePromise;
  templatePromise = new Promise((resolve, reject) => {
    new GLTFLoader().load(
      bassBlasterModelUrl,
      (gltf) => {
        const model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());

        // Orient: the barrel is the longest horizontal axis → face -Z.
        if (size.x >= size.z) {
          const sign = findMuzzleSign(model, box, "x");
          model.rotation.y = sign > 0 ? Math.PI / 2 : -Math.PI / 2;
        } else {
          const sign = findMuzzleSign(model, box, "z");
          if (sign > 0) model.rotation.y = Math.PI; // muzzle was at +Z → flip
        }

        // Uniform scale: total Z-length = 1 m, then center at the origin.
        const wrapper = new THREE.Group();
        wrapper.add(model);
        box.setFromObject(wrapper);
        const oriented = box.getSize(new THREE.Vector3());
        model.scale.setScalar(1 / Math.max(oriented.z, 1e-6));
        box.setFromObject(wrapper);
        const center = box.getCenter(new THREE.Vector3());
        model.position.sub(center);

        resolve(wrapper);
      },
      undefined,
      reject,
    );
  });
  return templatePromise;
}

/**
 * Cheap clone of the template: the scene graph is duplicated but every
 * geometry and material is SHARED with the template (three.js clone()
 * semantics) — no texture or buffer duplication ever happens.
 */
export function cloneBassBlaster(template: THREE.Group): THREE.Group {
  return template.clone(true);
}