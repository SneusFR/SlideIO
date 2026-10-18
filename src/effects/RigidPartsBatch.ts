import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { uberMaterialsFor, writeUberAttributes } from "../world/MapBatching";

/**
 * PERF — RIGID PARTS → ONE SKINNED DRAW PER MATERIAL.
 *
 * A third-person weapon is a small hierarchy of rigid parts (body, trigger,
 * limbs, cords, discs, tank, lid…) animated by node transforms (glTF clips /
 * procedural code). Every part was its own draw call — and its own shadow
 * draw — for every avatar holding it: 10 to 15 draws per bot for a few
 * thousand triangles.
 *
 * Here the parts that share a material become ONE SkinnedMesh whose "bones"
 * are the part objects themselves (identity inverse bind, every vertex
 * weighted 100 % to its own part). Nothing else changes: the controllers
 * keep animating the very same objects (transforms AND `visible`), the
 * skeleton reads their world matrices at render time, and a part that is
 * hidden (itself or an ancestor) is collapsed to a point that frame.
 *  - The source parts are moved to a layer no camera renders
 *    (`BATCHED_SOURCE_LAYER`): their own `visible` flag stays the
 *    controllers' business.
 *  - Merged geometries are cached per part-geometry set: every clone of a
 *    weapon reuses the same buffers (no per-respawn merge, no leak).
 *  - SkeletonUtils.clone (death corpses) clones the batch with its skeleton
 *    remapped onto the cloned parts — same frozen pose, same rules.
 *  - Parts whose materials only differ by CONSTANTS (colour, roughness,
 *    metalness, emissive — e.g. the Hex Sniper's armour / metal / rubber /
 *    lime pieces) share one batch with a MapUberMaterial (constants moved to
 *    vertex attributes, same image).
 *  - The batch never shares its material instance with a mesh that is drawn
 *    unskinned / instanced (popcorn kernels, flying discs…): three.js would
 *    re-select the program at every switch. Plain batches use one clone per
 *    source material (shared by every instance of the weapon).
 */
export const BATCHED_SOURCE_LAYER = 30;

/** Skeleton of a rigid-parts batch: bone = part, hidden part → zero matrix. */
class RigidPartsSkeleton extends THREE.Skeleton {
  /** The batch mesh using this skeleton (set by RigidPartsMesh.bind). */
  owner: THREE.Object3D | null = null;

  override update(): void {
    const bones = this.bones as THREE.Object3D[];
    const out = this.boneMatrices;
    if (!out) return;
    // Visibility is checked up to the batch's parent (the weapon root):
    // above it, a hidden ancestor hides the batch itself anyway.
    const stop = this.owner?.parent ?? null;
    for (let i = 0; i < bones.length; i++) {
      let shown = true;
      for (let o: THREE.Object3D | null = bones[i]; o && o !== stop; o = o.parent) {
        if (!o.visible) {
          shown = false;
          break;
        }
      }
      if (shown) bones[i].matrixWorld.toArray(out, i * 16); // identity inverse bind
      else out.fill(0, i * 16, i * 16 + 16);
    }
    if (this.boneTexture) this.boneTexture.needsUpdate = true;
  }

  override clone(): this {
    return new RigidPartsSkeleton(this.bones, this.boneInverses) as this;
  }
}

/** SkinnedMesh that tells its RigidPartsSkeleton who owns it (also after SkeletonUtils.clone). */
class RigidPartsMesh extends THREE.SkinnedMesh {
  override bind(skeleton: THREE.Skeleton, bindMatrix?: THREE.Matrix4): void {
    super.bind(skeleton, bindMatrix);
    if (skeleton instanceof RigidPartsSkeleton) skeleton.owner = this;
  }
}

/** True for a batch built by batchRigidParts (also its SkeletonUtils clones). */
export function isRigidPartsBatch(object: THREE.Object3D): boolean {
  return object instanceof RigidPartsMesh;
}

/** Merged geometry per ordered list of part geometries (shared by every clone). */
const geometryCache = new Map<string, THREE.BufferGeometry | null>();
const IDENTITY = new THREE.Matrix4();
const _rel = new THREE.Matrix4();
const _rootInv = new THREE.Matrix4();
const _sphere = new THREE.Sphere();

interface BatchOptions {
  /** Margin added to the culling sphere (animated parts move a little). */
  cullMargin?: number;
  /** Merge parts of constant-only materials into uber batches (default true). */
  uber?: boolean;
}

/** Attributes an uber batch keeps from its parts (the constants are written per vertex). */
const UBER_KEPT = ["position", "normal"] as const;

/** Batch material per plain source material (shared by every batch of that weapon). */
const batchMaterials = new WeakMap<THREE.Material, THREE.Material>();
function batchMaterialOf(source: THREE.Material): THREE.Material {
  let material = batchMaterials.get(source);
  if (!material) {
    material = source.clone();
    // Material.copy never copies the shader hooks.
    material.onBeforeCompile = source.onBeforeCompile;
    material.customProgramCacheKey = source.customProgramCacheKey;
    batchMaterials.set(source, material);
  }
  return material;
}

/**
 * Merges the rigid parts of `root` (meshes sharing a material) into skinned
 * batches added under `root`. Returns the number of draw calls removed.
 * Parts left alone: instanced / skinned / points / lines, multi-material,
 * transparent, morphed, grouped or draw-ranged geometry, custom
 * onBeforeRender, parts with a different render order than their group.
 */
export function batchRigidParts(root: THREE.Object3D, options: BatchOptions = {}): number {
  root.updateMatrixWorld(true);
  _rootInv.copy(root.matrixWorld).invert();
  const candidates: THREE.Mesh[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
    if (mesh instanceof RigidPartsMesh || !mesh.layers.isEnabled(0)) return;
    if (Array.isArray(mesh.material) || mesh.material.transparent) return;
    if (mesh.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender) return;
    const g = mesh.geometry;
    if (!g.getAttribute("position") || Object.keys(g.morphAttributes).length > 0 || g.groups.length > 1) return;
    if (g.drawRange.start !== 0 || g.drawRange.count !== Infinity) return;
    candidates.push(mesh);
  });

  const uberOf =
    options.uber === false
      ? new Map<THREE.Material, THREE.Material>()
      : uberMaterialsFor(candidates.map((m) => m.material as THREE.Material));
  // Uber pieces keep position + normal only: setups sampling a map (shared
  // emissive / AO map → uv needed) stay plain batches.
  for (const [source, uber] of uberOf) {
    const u = uber as THREE.MeshStandardMaterial;
    if (u.emissiveMap || u.aoMap) uberOf.delete(source);
  }
  const groups = new Map<string, THREE.Mesh[]>();
  for (const mesh of candidates) {
    const g = mesh.geometry;
    const source = mesh.material as THREE.Material;
    const uber = uberOf.get(source);
    if (uber && !UBER_KEPT.every((name) => g.getAttribute(name))) continue;
    const names = uber ? [...UBER_KEPT] : Object.keys(g.attributes).sort();
    const signature = names
      .map((name) => {
        const a = g.getAttribute(name) as THREE.BufferAttribute;
        return `${name}:${a.itemSize}:${a.normalized ? 1 : 0}:${(a.array as ArrayLike<number>).constructor.name}`;
      })
      .join(",");
    const key = `${uber ? `uber:${uber.uuid}` : source.uuid}|${mesh.renderOrder}|${signature}`;
    const list = groups.get(key) ?? [];
    list.push(mesh);
    groups.set(key, list);
  }

  let saved = 0;
  for (const parts of groups.values()) {
    if (parts.length < 2) continue;
    const first = parts[0];
    const uber = uberOf.get(first.material as THREE.Material) ?? null;
    const geometry = mergedGeometryOf(parts, uber !== null);
    if (!geometry) continue;
    const skeleton = new RigidPartsSkeleton(
      parts as unknown as THREE.Bone[],
      parts.map(() => new THREE.Matrix4()),
    );
    const batch = new RigidPartsMesh(geometry, uber ?? batchMaterialOf(first.material as THREE.Material));
    batch.name = `${root.name || "parts"}_batch_${uber ? "uber" : (first.material as THREE.Material).name || "material"}`;
    batch.bind(skeleton, IDENTITY);
    batch.castShadow = parts.some((p) => p.castShadow);
    batch.receiveShadow = parts.some((p) => p.receiveShadow);
    batch.renderOrder = first.renderOrder;
    batch.raycast = () => {};
    batch.userData.noOutline = first.userData.noOutline === true;
    // Culling sphere in the root's space (= the batch's space): union of the
    // parts at rest + margin for their animation.
    const sphere = new THREE.Sphere();
    for (const p of parts) {
      if (!p.geometry.boundingSphere) p.geometry.computeBoundingSphere();
      _rel.multiplyMatrices(_rootInv, p.matrixWorld);
      _sphere.copy(p.geometry.boundingSphere!).applyMatrix4(_rel);
      sphere.union(_sphere);
    }
    sphere.radius += options.cullMargin ?? Math.max(0.15, sphere.radius * 0.35);
    batch.boundingSphere = sphere;
    batch.frustumCulled = true;
    root.add(batch);
    for (const p of parts) p.layers.set(BATCHED_SOURCE_LAYER);
    // The bone texture is per instance: freed when the weapon leaves its
    // mount (re-created lazily if it is mounted again).
    root.addEventListener("removed", () => skeleton.dispose());
    saved += parts.length - 1;
  }
  return saved;
}

function mergedGeometryOf(parts: THREE.Mesh[], uber: boolean): THREE.BufferGeometry | null {
  // Mirrored parts (negative determinant at rest) get their winding flipped:
  // skinning keeps the mirror, three's per-object front-face flip is gone.
  const mirrored = parts.map((p) => {
    _rel.multiplyMatrices(_rootInv, p.matrixWorld);
    return _rel.determinant() < 0;
  });
  // Uber pieces carry their material's constants: the key includes them.
  const key =
    (uber ? "uber:" : "") +
    parts
      .map((p, i) => `${p.geometry.uuid}${mirrored[i] ? "~" : ""}${uber ? `@${(p.material as THREE.Material).uuid}` : ""}`)
      .join("/");
  const cached = geometryCache.get(key);
  if (cached !== undefined) return cached;
  const pieces = parts.map((p, bone) => {
    const g = p.geometry.clone();
    if (uber) {
      // Constants → vertex attributes (the vertex colour, if any, is folded
      // in), then only the attributes every uber piece has.
      writeUberAttributes(g, p.material as THREE.MeshStandardMaterial);
      const keep = new Set<string>([...UBER_KEPT, "color", "aEmissive", "aRoughness", "aMetalness"]);
      for (const name of Object.keys(g.attributes)) if (!keep.has(name)) g.deleteAttribute(name);
    }
    for (const name of Object.keys(g.attributes)) {
      if (name === "skinIndex" || name === "skinWeight") g.deleteAttribute(name);
    }
    const count = g.getAttribute("position").count;
    if (!g.index) g.setIndex([...Array(count).keys()]);
    if (mirrored[bone]) {
      const idx = g.index!;
      for (let i = 0; i + 2 < idx.count; i += 3) {
        const b = idx.getX(i + 1);
        idx.setX(i + 1, idx.getX(i + 2));
        idx.setX(i + 2, b);
      }
    }
    g.clearGroups();
    const skinIndex = new Uint16Array(count * 4);
    const skinWeight = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      skinIndex[i * 4] = bone;
      skinWeight[i * 4] = 1;
    }
    g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
    g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));
    return g;
  });
  const merged = mergeGeometries(pieces, false);
  pieces.forEach((g) => g.dispose());
  if (merged) merged.name = "rigidPartsBatch";
  geometryCache.set(key, merged);
  return merged;
}
