import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { buildStaticBatches, type StaticEntry } from "./GivreRenderOptim";

/**
 * PERF — draw-call batching shared by the maps (Givre, Jungle, Yard).
 *
 * Every draw call costs CPU twice (three.js setup + the browser's GPU
 * process), and a material SWITCH costs a full uniform refresh on top. The
 * map GLBs come as many small meshes over a few materials that only differ
 * by CONSTANTS (colour, roughness, metalness, emissive…):
 *
 *  1. MapUberMaterial / applyUberMaterial: those constants move into VERTEX
 *     ATTRIBUTES, so the eligible materials share ONE material (identical
 *     image: the attributes are constant per source material — exactly the
 *     former uniforms).
 *  2. batchStaticMap: the static meshes are baked to world space, merged per
 *     material and split on a coarse XZ grid (frustum culling kept), each
 *     batch with its BVH for the shot raycasts.
 *  3. batchAnimatedMeshes: rigid ANIMATED meshes (fans, gauges, garlands…)
 *     become one SkinnedMesh per material whose bones are the original
 *     meshes — the mixer keeps animating the very same objects.
 */

// ---------------------------------------------------------------------------
// 1. Uber material
// ---------------------------------------------------------------------------

export class MapUberMaterial extends THREE.MeshStandardMaterial {
  readonly isMapUberMaterial = true;

  constructor(parameters?: THREE.MeshStandardMaterialParameters) {
    super(parameters);
    // Also set on clones (Material.copy never copies onBeforeCompile): the
    // FrontSide variant built by buildStaticBatches keeps the patch.
    this.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nattribute vec3 aEmissive;\nattribute float aRoughness;\nattribute float aMetalness;\n" +
            "varying vec3 vUberEmissive;\nvarying float vUberRoughness;\nvarying float vUberMetalness;",
        )
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\n\tvUberEmissive = aEmissive;\n\tvUberRoughness = aRoughness;\n\tvUberMetalness = aMetalness;",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vUberEmissive;\nvarying float vUberRoughness;\nvarying float vUberMetalness;",
        )
        .replace("#include <roughnessmap_fragment>", "float roughnessFactor = roughness * vUberRoughness;")
        .replace("#include <metalnessmap_fragment>", "float metalnessFactor = metalness * vUberMetalness;")
        .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vUberEmissive;");
    };
    this.customProgramCacheKey = () => "map-uber-v1";
  }
}

/** Texture identity for the uber merge: same image AND same sampling / transform. */
function sameTexture(a: THREE.Texture | null, b: THREE.Texture | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.source === b.source &&
    a.channel === b.channel &&
    a.colorSpace === b.colorSpace &&
    a.flipY === b.flipY &&
    a.minFilter === b.minFilter &&
    a.magFilter === b.magFilter &&
    a.wrapS === b.wrapS &&
    a.wrapT === b.wrapT &&
    a.anisotropy === b.anisotropy &&
    a.offset.equals(b.offset) &&
    a.repeat.equals(b.repeat) &&
    a.rotation === b.rotation &&
    a.center.equals(b.center)
  );
}

/** Constant-only standard material (optional SHARED emissive / AO maps). */
function uberCandidate(m: THREE.Material, keep: ReadonlySet<string>): m is THREE.MeshStandardMaterial {
  const s = m as THREE.MeshStandardMaterial;
  if (!s.isMeshStandardMaterial || (s as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) return false;
  if (keep.has(s.name) || s.transparent || s.alphaTest > 0 || s.wireframe || s.flatShading) return false;
  if (s.map || s.roughnessMap || s.metalnessMap || s.normalMap || s.bumpMap || s.displacementMap) return false;
  if (s.alphaMap || s.lightMap || s.envMap || s.opacity !== 1) return false;
  if (s.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) return false;
  return true;
}

/**
 * Vertex layout of a geometry as far as merging is concerned (attribute
 * names, sizes, normalization, storage + indexing). `color` is ignored: the
 * uber merge rewrites it on every entry.
 */
function vertexLayout(g: THREE.BufferGeometry): string {
  const parts = Object.keys(g.attributes)
    .filter((name) => name !== "color")
    .sort()
    .map((name) => {
      const a = g.getAttribute(name) as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
      const storage = (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute
        ? "interleaved"
        : (a as THREE.BufferAttribute).array.constructor.name;
      return `${name}:${a.itemSize}:${a.normalized ? 1 : 0}:${storage}`;
    });
  const morphs = Object.keys(g.morphAttributes).length;
  return `${parts.join(",")}|${g.index ? "indexed" : "flat"}|m${morphs}`;
}

/** Everything but the per-vertex constants must match inside one uber group. */
function sameSetup(a: THREE.MeshStandardMaterial, b: THREE.MeshStandardMaterial): boolean {
  return (
    sameTexture(a.emissiveMap, b.emissiveMap) &&
    sameTexture(a.aoMap, b.aoMap) &&
    a.aoMapIntensity === b.aoMapIntensity &&
    a.side === b.side &&
    a.shadowSide === b.shadowSide &&
    a.envMapIntensity === b.envMapIntensity &&
    a.fog === b.fog &&
    a.depthTest === b.depthTest &&
    a.depthWrite === b.depthWrite &&
    a.blending === b.blending &&
    a.polygonOffset === b.polygonOffset &&
    a.polygonOffsetFactor === b.polygonOffsetFactor &&
    a.polygonOffsetUnits === b.polygonOffsetUnits &&
    a.toneMapped === b.toneMapped &&
    a.dithering === b.dithering &&
    a.colorWrite === b.colorWrite &&
    // Stencil state (third-person weapons are enemy-outline occluders).
    a.stencilWrite === b.stencilWrite &&
    a.stencilWriteMask === b.stencilWriteMask &&
    a.stencilFunc === b.stencilFunc &&
    a.stencilRef === b.stencilRef &&
    a.stencilFuncMask === b.stencilFuncMask &&
    a.stencilFail === b.stencilFail &&
    a.stencilZFail === b.stencilZFail &&
    a.stencilZPass === b.stencilZPass
  );
}

/** The uber material standing for `members` (all sharing `reference`'s setup). */
function uberFor(r: THREE.MeshStandardMaterial, members: Iterable<THREE.Material>): MapUberMaterial {
  const uber = new MapUberMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 1,
    metalness: 1,
    emissive: 0xffffff,
    emissiveIntensity: 1,
    emissiveMap: r.emissiveMap,
    aoMap: r.aoMap,
    aoMapIntensity: r.aoMapIntensity,
    envMapIntensity: r.envMapIntensity,
    side: r.side,
    fog: r.fog,
    depthTest: r.depthTest,
    depthWrite: r.depthWrite,
    toneMapped: r.toneMapped,
    polygonOffset: r.polygonOffset,
    polygonOffsetFactor: r.polygonOffsetFactor,
    polygonOffsetUnits: r.polygonOffsetUnits,
  });
  uber.shadowSide = r.shadowSide;
  uber.blending = r.blending;
  uber.dithering = r.dithering;
  uber.colorWrite = r.colorWrite;
  uber.stencilWrite = r.stencilWrite;
  uber.stencilWriteMask = r.stencilWriteMask;
  uber.stencilFunc = r.stencilFunc;
  uber.stencilRef = r.stencilRef;
  uber.stencilFuncMask = r.stencilFuncMask;
  uber.stencilFail = r.stencilFail;
  uber.stencilZFail = r.stencilZFail;
  uber.stencilZPass = r.stencilZPass;
  uber.name = `uber(${[...members].map((m) => m.name).join("+")})`.slice(0, 120);
  return uber;
}

/**
 * Uber materials for every eligible material of `materials` (constant-only,
 * see uberCandidate) that shares its texture / state setup with at least
 * one other: source → its group's MapUberMaterial. Groups are cached by
 * member set, so the instances of one model share the same uber material.
 */
const uberCache = new Map<string, MapUberMaterial>();
export function uberMaterialsFor(
  materials: Iterable<THREE.Material>,
  keep: ReadonlySet<string> = new Set(),
): Map<THREE.Material, MapUberMaterial> {
  const setups: { reference: THREE.MeshStandardMaterial; members: Set<THREE.MeshStandardMaterial> }[] = [];
  for (const m of new Set(materials)) {
    if (!uberCandidate(m, keep)) continue;
    let setup = setups.find((s) => sameSetup(s.reference, m));
    if (!setup) {
      setup = { reference: m, members: new Set() };
      setups.push(setup);
    }
    setup.members.add(m);
  }
  const out = new Map<THREE.Material, MapUberMaterial>();
  for (const setup of setups) {
    if (setup.members.size < 2) continue;
    const key = [...setup.members].map((m) => m.uuid).sort().join("+");
    let uber = uberCache.get(key);
    if (!uber) {
      uber = uberFor(setup.reference, setup.members);
      uberCache.set(key, uber);
    }
    for (const m of setup.members) out.set(m, uber);
  }
  return out;
}

/**
 * The constants of `source` as uber vertex attributes on `geometry` (whose
 * own `color`, if `source.vertexColors`, is folded into the new `color`):
 * colour, emissive × intensity, roughness, metalness — see MapUberMaterial.
 */
export function writeUberAttributes(geometry: THREE.BufferGeometry, source: THREE.MeshStandardMaterial): void {
  const n = geometry.getAttribute("position").count;
  const vc = source.vertexColors ? (geometry.getAttribute("color") as THREE.BufferAttribute | undefined) : undefined;
  const color = new Float32Array(n * 3);
  const tint = new Float32Array(n * 3);
  const emissive = new THREE.Color().copy(source.emissive).multiplyScalar(source.emissiveIntensity);
  for (let i = 0; i < n; i++) {
    color[i * 3] = source.color.r * (vc ? vc.getX(i) : 1);
    color[i * 3 + 1] = source.color.g * (vc ? vc.getY(i) : 1);
    color[i * 3 + 2] = source.color.b * (vc ? vc.getZ(i) : 1);
    tint[i * 3] = emissive.r;
    tint[i * 3 + 1] = emissive.g;
    tint[i * 3 + 2] = emissive.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(color, 3));
  geometry.setAttribute("aEmissive", new THREE.BufferAttribute(tint, 3));
  geometry.setAttribute("aRoughness", new THREE.BufferAttribute(new Float32Array(n).fill(source.roughness), 1));
  geometry.setAttribute("aMetalness", new THREE.BufferAttribute(new Float32Array(n).fill(source.metalness), 1));
}

/**
 * Rewrites the eligible entries IN PLACE onto shared MapUberMaterials (one
 * per texture / state setup with ≥ 2 materials). Each entry geometry gets
 * `color` (base colour × its vertex colours), `aEmissive` (emissive ×
 * intensity), `aRoughness`, `aMetalness`. Entry geometries must be private
 * to their entry (world-space clones). Returns the uber materials.
 */
export function applyUberMaterial(entries: StaticEntry[], keep: ReadonlySet<string> = new Set()): THREE.Material[] {
  // The entries of one uber group are later merged together: their vertex
  // layouts must match (mergeGeometries refuses mixed attribute sets). A
  // material whose entries disagree among themselves is left alone.
  const layoutOf = new Map<THREE.Material, string | null>();
  for (const e of entries) {
    const layout = vertexLayout(e.geometry);
    const known = layoutOf.get(e.material);
    layoutOf.set(e.material, known === undefined || known === layout ? layout : null);
  }
  const groups: { reference: THREE.MeshStandardMaterial; layout: string; members: Set<THREE.MeshStandardMaterial> }[] = [];
  const groupOf = new Map<THREE.Material, (typeof groups)[number]>();
  for (const e of entries) {
    const m = e.material;
    const layout = layoutOf.get(m);
    if (groupOf.has(m) || !layout || !uberCandidate(m, keep)) continue;
    let group = groups.find((g) => g.layout === layout && sameSetup(g.reference, m));
    if (!group) {
      group = { reference: m, layout, members: new Set() };
      groups.push(group);
    }
    group.members.add(m);
    groupOf.set(m, group);
  }

  const ubers = new Map<(typeof groups)[number], MapUberMaterial>();
  for (const group of groups) {
    if (group.members.size < 2) continue;
    ubers.set(group, uberFor(group.reference, group.members));
  }

  const emissive = new THREE.Color();
  for (const e of entries) {
    const m = e.material as THREE.MeshStandardMaterial;
    const group = groupOf.get(m);
    const uber = group ? ubers.get(group) : undefined;
    if (!uber) continue;
    const g = e.geometry;
    const n = g.getAttribute("position").count;
    const color = new Float32Array(n * 3);
    const tint = new Float32Array(n * 3);
    const rough = new Float32Array(n).fill(m.roughness);
    const metal = new Float32Array(n).fill(m.metalness);
    emissive.copy(m.emissive).multiplyScalar(m.emissiveIntensity);
    const vc = m.vertexColors ? (g.getAttribute("color") as THREE.BufferAttribute | undefined) : undefined;
    for (let i = 0; i < n; i++) {
      const r = vc ? vc.getX(i) : 1;
      const gg = vc ? vc.getY(i) : 1;
      const b = vc ? vc.getZ(i) : 1;
      color[i * 3] = m.color.r * r;
      color[i * 3 + 1] = m.color.g * gg;
      color[i * 3 + 2] = m.color.b * b;
      tint[i * 3] = emissive.r;
      tint[i * 3 + 1] = emissive.g;
      tint[i * 3 + 2] = emissive.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(color, 3));
    g.setAttribute("aEmissive", new THREE.BufferAttribute(tint, 3));
    g.setAttribute("aRoughness", new THREE.BufferAttribute(rough, 1));
    g.setAttribute("aMetalness", new THREE.BufferAttribute(metal, 1));
    e.material = uber;
  }
  return [...ubers.values()];
}

// ---------------------------------------------------------------------------
// 2. Static map batching (Jungle / Yard — Givre has its own tuned pipeline)
// ---------------------------------------------------------------------------

/** Plain Float32, non-interleaved, de-normalized copy (quantized glTF attributes). */
function toFloatAttribute(src: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute {
  const plain = !(src as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute &&
    !src.normalized && (src as THREE.BufferAttribute).array instanceof Float32Array;
  if (plain) return (src as THREE.BufferAttribute).clone();
  const n = src.count;
  const size = src.itemSize;
  const out = new Float32Array(n * size);
  for (let i = 0; i < n; i++) {
    out[i * size] = src.getX(i);
    if (size > 1) out[i * size + 1] = src.getY(i);
    if (size > 2) out[i * size + 2] = src.getZ(i);
    if (size > 3) out[i * size + 3] = src.getW(i);
  }
  return new THREE.BufferAttribute(out, size);
}

export interface StaticMapBatchOptions {
  /** Meshes left exactly as they are (animated, shader-patched by name…). */
  exclude?: (mesh: THREE.Mesh) => boolean;
  /** XZ grid cell size (m) for the culling split. */
  cellSize?: number;
  /** Merge eligible constant-only materials into uber materials. */
  uber?: boolean;
  /** Material names never touched by the uber merge. */
  keepMaterials?: ReadonlySet<string>;
  /** Called on every merged batch (BVH, flags…). */
  onBatch?: (mesh: THREE.Mesh) => void;
}

/**
 * Bakes the static meshes under `root` to world space and replaces them by
 * merged batches (per material, split on an XZ grid). Returns the batches
 * (already added to `root`). A removed mesh with children is replaced by an
 * empty holder with the SAME local transform (children keep working).
 */
export function batchStaticMap(root: THREE.Object3D, options: StaticMapBatchOptions = {}): THREE.Mesh[] {
  root.updateMatrixWorld(true);
  const sources: THREE.Mesh[] = [];
  const entries: StaticEntry[] = [];
  // Shadow flags of each entry's SOURCE mesh (the uber material is shared).
  const castOf = new Map<StaticEntry, boolean>();
  const receiveOf = new Map<StaticEntry, boolean>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) return;
    if (Array.isArray(mesh.material) || !mesh.visible || options.exclude?.(mesh)) return;
    const src = mesh.geometry;
    // (groups are ignored by three with a single material — nothing to keep)
    if (Object.keys(src.morphAttributes).length > 0) return;
    if (src.drawRange.start !== 0 || src.drawRange.count !== Infinity) return;
    const g = new THREE.BufferGeometry();
    for (const name of Object.keys(src.attributes)) {
      g.setAttribute(name, toFloatAttribute(src.getAttribute(name) as THREE.BufferAttribute));
    }
    if (src.index) g.setIndex(src.index.clone());
    else g.setIndex([...Array(g.getAttribute("position").count).keys()]);
    g.applyMatrix4(mesh.matrixWorld);
    if (mesh.matrixWorld.determinant() < 0) {
      const idx = g.index!;
      for (let i = 0; i + 2 < idx.count; i += 3) {
        const b = idx.getX(i + 1);
        idx.setX(i + 1, idx.getX(i + 2));
        idx.setX(i + 2, b);
      }
    }
    const entry: StaticEntry = { geometry: g, material: mesh.material };
    castOf.set(entry, mesh.castShadow);
    receiveOf.set(entry, mesh.receiveShadow);
    entries.push(entry);
    sources.push(mesh);
  });
  if (entries.length === 0) return [];

  if (options.uber) applyUberMaterial(entries, options.keepMaterials ?? new Set());

  // Attribute sets must match inside a merge group: split by signature.
  const signature = (g: THREE.BufferGeometry) =>
    Object.keys(g.attributes).sort().map((n) => `${n}:${g.getAttribute(n).itemSize}`).join(",");
  const bySignature = new Map<string, StaticEntry[]>();
  for (const e of entries) {
    const key = `${signature(e.geometry)}|${castOf.get(e)}|${receiveOf.get(e)}`;
    const list = bySignature.get(key) ?? [];
    list.push(e);
    bySignature.set(key, list);
  }

  const box = new THREE.Box3();
  for (const e of entries) {
    e.geometry.computeBoundingBox();
    box.union(e.geometry.boundingBox!);
  }
  const cell = options.cellSize ?? 40;
  const grid = {
    minX: box.min.x,
    minZ: box.min.z,
    maxX: box.max.x + 1e-3,
    maxZ: box.max.z + 1e-3,
    cellsX: Math.max(1, Math.round((box.max.x - box.min.x) / cell)),
    cellsZ: Math.max(1, Math.round((box.max.z - box.min.z) / cell)),
  };

  const out: THREE.Mesh[] = [];
  const holderParent = new THREE.Group();
  holderParent.name = `${root.name || "map"}_batches`;
  for (const [key, list] of bySignature) {
    const [, cast, receive] = key.split("|");
    const batches = buildStaticBatches(list, (gs) => mergeGeometries(gs, false), {
      grid,
      chunkMinTriangles: 4000,
      singleSidedMaxThickness: 0, // keep the authored sidedness
      keepMaterials: options.keepMaterials,
    });
    for (const b of batches) {
      b.geometry.computeBoundingBox();
      b.geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(b.geometry, b.material);
      mesh.name = `${holderParent.name}_${b.material.name}${b.cell >= 0 ? `_c${b.cell}` : ""}`;
      mesh.castShadow = cast === "true";
      mesh.receiveShadow = receive === "true";
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      options.onBatch?.(mesh);
      holderParent.add(mesh);
      out.push(mesh);
    }
  }
  for (const e of entries) e.geometry.dispose();

  // Remove the sources (holders keep the transforms of their children).
  for (const mesh of sources) {
    const parent = mesh.parent;
    if (!parent) continue;
    if (mesh.children.length > 0) {
      const holder = new THREE.Object3D();
      holder.name = mesh.name;
      holder.position.copy(mesh.position);
      holder.quaternion.copy(mesh.quaternion);
      holder.scale.copy(mesh.scale);
      parent.add(holder);
      for (const child of [...mesh.children]) holder.add(child);
    }
    parent.remove(mesh);
  }
  holderParent.matrixAutoUpdate = false;
  root.add(holderParent);
  // The batches are in WORLD space: cancel the root's own transform.
  root.updateMatrixWorld(true);
  holderParent.matrix.copy(root.matrixWorld).invert();
  holderParent.matrixWorldNeedsUpdate = true;
  return out;
}

// ---------------------------------------------------------------------------
// 3. Animated rigid meshes → skinned batches
// ---------------------------------------------------------------------------

/**
 * Rigid meshes of ANIMATED subtrees → one SkinnedMesh per material whose
 * "bones" are the original meshes (identity inverse bind, each vertex 100 %
 * weighted to its own source): the mixer keeps animating the same nodes,
 * the skeleton reads their matrixWorld each frame → identical motion.
 * Sources stay in the graph, hidden (raycasts on them still work: three's
 * Raycaster ignores `visible`). The batch uses a CLONE of the material
 * (shared textures) so the skinned program never alternates with the
 * static one on the same material instance.
 * Skipped: meshes with children, mirrored / transparent / multi-material
 * ones, materials in `keep`, attribute-less ones. Returns the batches (the
 * caller adds them to the scene).
 */
export function batchAnimatedMeshes(
  meshes: Iterable<THREE.Object3D>,
  options: {
    keep?: ReadonlySet<string>;
    attributes?: readonly string[];
    /**
     * Constant-only materials (see applyUberMaterial) share ONE skinned
     * uber batch instead of one batch per material: fewer draws AND fewer
     * bone-texture uploads per frame. Same image.
     */
    uber?: boolean;
  } = {},
): THREE.SkinnedMesh[] {
  const keepNames = options.keep ?? new Set<string>();
  const candidates: { mesh: THREE.Mesh; names: string[] }[] = [];
  for (const o of meshes) {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) continue;
    if (!mesh.visible || mesh.children.length > 0 || Array.isArray(mesh.material)) continue;
    const material = mesh.material;
    if (keepNames.has(material.name) || material.transparent) continue;
    const geometry = mesh.geometry;
    if (Object.keys(geometry.morphAttributes).length > 0) continue;
    if (geometry.drawRange.start !== 0 || geometry.drawRange.count !== Infinity) continue;
    const names = (options.attributes ?? Object.keys(geometry.attributes).sort()).filter(
      (name) => name !== "skinIndex" && name !== "skinWeight",
    );
    if (names.some((name) => !geometry.getAttribute(name))) continue;
    mesh.updateWorldMatrix(true, false);
    if (mesh.matrixWorld.determinant() <= 0) continue;
    candidates.push({ mesh, names });
  }

  // Uber groups: constant-only materials with the same texture / state setup.
  const uberOf = new Map<THREE.Material, MapUberMaterial>();
  if (options.uber) {
    const setups: { reference: THREE.MeshStandardMaterial; members: Set<THREE.MeshStandardMaterial> }[] = [];
    for (const { mesh } of candidates) {
      const m = mesh.material as THREE.Material;
      if (!uberCandidate(m, keepNames)) continue;
      // An existing vertex colour is folded into the uber colour attribute:
      // it must be one of the batched attributes.
      if (m.vertexColors && !mesh.geometry.getAttribute("color")) continue;
      let setup = setups.find((s) => s.members.has(m) || sameSetup(s.reference, m));
      if (!setup) {
        setup = { reference: m, members: new Set() };
        setups.push(setup);
      }
      setup.members.add(m);
    }
    for (const setup of setups) {
      if (setup.members.size < 2) continue;
      const uber = uberFor(setup.reference, setup.members);
      for (const m of setup.members) uberOf.set(m, uber);
    }
  }

  const groups = new Map<string, { material: THREE.Material; uber: boolean; names: string[]; sources: THREE.Mesh[] }>();
  for (const { mesh, names } of candidates) {
    const source = mesh.material as THREE.Material;
    const uber = uberOf.get(source);
    const material = uber ?? source;
    // Uber parts: the source colour attribute (if any) is folded into the
    // uber `color` written below — never copied as such.
    const partNames = uber ? names.filter((n) => n !== "color") : names;
    const key = `${material.uuid}|${partNames.join(",")}|${mesh.castShadow}|${mesh.receiveShadow}`;
    const group = groups.get(key) ?? { material, uber: !!uber, names: partNames, sources: [] };
    group.sources.push(mesh);
    groups.set(key, group);
  }

  const out: THREE.SkinnedMesh[] = [];
  const emissive = new THREE.Color();
  for (const { material, uber, names, sources } of groups.values()) {
    if (sources.length < 2) continue; // nothing to gain
    const parts = sources.map((mesh, bone) => {
      const src = mesh.geometry;
      const g = new THREE.BufferGeometry();
      for (const name of names) {
        g.setAttribute(name, toFloatAttribute(src.getAttribute(name) as THREE.BufferAttribute));
      }
      const count = g.getAttribute("position").count;
      if (src.index) g.setIndex(src.index.clone());
      else g.setIndex([...Array(count).keys()]);
      if (uber) {
        // The source material's constants, per vertex (see applyUberMaterial).
        const m = mesh.material as THREE.MeshStandardMaterial;
        const vc = m.vertexColors ? (src.getAttribute("color") as THREE.BufferAttribute | undefined) : undefined;
        const color = new Float32Array(count * 3);
        const tint = new Float32Array(count * 3);
        emissive.copy(m.emissive).multiplyScalar(m.emissiveIntensity);
        for (let i = 0; i < count; i++) {
          color[i * 3] = m.color.r * (vc ? vc.getX(i) : 1);
          color[i * 3 + 1] = m.color.g * (vc ? vc.getY(i) : 1);
          color[i * 3 + 2] = m.color.b * (vc ? vc.getZ(i) : 1);
          tint[i * 3] = emissive.r;
          tint[i * 3 + 1] = emissive.g;
          tint[i * 3 + 2] = emissive.b;
        }
        g.setAttribute("color", new THREE.BufferAttribute(color, 3));
        g.setAttribute("aEmissive", new THREE.BufferAttribute(tint, 3));
        g.setAttribute("aRoughness", new THREE.BufferAttribute(new Float32Array(count).fill(m.roughness), 1));
        g.setAttribute("aMetalness", new THREE.BufferAttribute(new Float32Array(count).fill(m.metalness), 1));
      }
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
    const geometry = mergeGeometries(parts, false);
    parts.forEach((g) => g.dispose());
    if (!geometry) continue;
    geometry.name = `animated_${uber ? "uber" : material.name}`;
    const skeleton = new THREE.Skeleton(
      sources as unknown as THREE.Bone[],
      sources.map(() => new THREE.Matrix4()),
    );
    // Plain materials are cloned (the skinned program never alternates with
    // the static one on a shared instance); uber materials are private.
    const batch = new THREE.SkinnedMesh(geometry, uber ? material : material.clone());
    batch.name = `animated_${uber ? "uber" : material.name}`;
    // Identity bind: vertices are in their source's local space, the bones'
    // matrixWorld put them in the world (attached mode cancels the batch's
    // own parent transform).
    batch.bind(skeleton, new THREE.Matrix4());
    batch.frustumCulled = false; // spread over the map, a few thousand triangles
    batch.castShadow = sources[0].castShadow;
    batch.receiveShadow = sources[0].receiveShadow;
    batch.raycast = () => {}; // visual only (the hidden sources keep the hits)
    // Moves every frame: never baked into a static shadow cache.
    batch.userData.dynamicShadow = true;
    for (const s of sources) s.visible = false;
    out.push(batch);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Static transforms
// ---------------------------------------------------------------------------

/**
 * PERF: every node under `root` that is not in `animated` gets a frozen
 * local matrix (matrixAutoUpdate = false, composed once now). With the scene
 * root frozen too (Game), a static subtree is then only VISITED by the
 * per-frame scene-graph updates — no recompose, no forced world multiply.
 * A frozen node riding an animated parent still follows it (the parent's
 * update forces its subtree). Call once the map is final; nodes animated by
 * code (position / rotation / scale written at runtime) must be listed in
 * `animated` or not be under `root`.
 */
export function freezeStaticTransforms(
  root: THREE.Object3D,
  animated: ReadonlySet<THREE.Object3D> = new Set(),
): void {
  root.traverse((o) => {
    if (animated.has(o)) return;
    o.updateMatrix();
    o.matrixAutoUpdate = false;
  });
}
