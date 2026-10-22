import * as THREE from "three";

/**
 * GIVRE rendering optimisations — helpers without asset import, so they run
 * in the browser (GivreMap / Game) AND headless in Node
 * (scripts/test-givre-render-optim.mts). Only buildLimitedMipmaps needs the
 * DOM (it returns null without it).
 *
 *  1. SPATIAL CHUNKS: the static map used to be merged into ONE mesh per
 *     material, each spanning the whole 280 × 220 m map — nothing could ever
 *     be frustum-culled and the opaque sort could not draw near → far. Every
 *     large merged material is now split on a coarse XZ grid (triangle
 *     centroid → cell): off-screen cells are culled, the rest drawn
 *     front-to-back.
 *  2. SINGLE-SIDED SOLIDS: every glb material is doubleSided. Closed,
 *     consistently wound, OUTWARD-facing meshes too thin to ever contain the
 *     camera (crates, slabs, posts, bulbs…) are drawn FrontSide: identical
 *     image from outside, half the rasterised triangles (main pass AND
 *     shadow pass). Open surfaces (most walls / ground) stay DoubleSide.
 *  3. FRONT-TO-BACK opaque sort (renderer.setOpaqueSort): three's default
 *     sort groups by material BEFORE depth, which defeats early-Z on a map
 *     whose meshes overlap in screen space.
 *  4. Short mip chain for the 2048² baked lightmaps (buildLimitedMipmaps).
 */

/** XZ grid over the map (metres). */
export interface ChunkGrid {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  cellsX: number;
  cellsZ: number;
}

/** One static source mesh, already in WORLD space (winding already fixed). */
export interface StaticEntry {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

/** One draw call of the optimised static map. */
export interface StaticBatch {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Grid cell index (−1 = not split). */
  cell: number;
  /** True when drawn with the FrontSide clone of the glb material. */
  singleSided: boolean;
}

export interface StaticBatchOptions {
  grid: ChunkGrid;
  /** Materials (per side variant) with fewer triangles stay one mesh. */
  chunkMinTriangles: number;
  /**
   * Closed outward meshes whose SMALLEST bounding-box side is at most this
   * (m) are drawn single-sided. ≤ 0 disables the optimisation.
   */
  singleSidedMaxThickness: number;
  /** Material names that must never be cloned (mutated at runtime). */
  keepMaterials?: ReadonlySet<string>;
}

/** Triangle count of a (possibly indexed) geometry. */
export function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.index;
  return Math.floor((index ? index.count : geometry.getAttribute("position").count) / 3);
}

/** Grid cell of an XZ point (clamped to the grid). */
export function cellOf(grid: ChunkGrid, x: number, z: number): number {
  const fx = (x - grid.minX) / (grid.maxX - grid.minX);
  const fz = (z - grid.minZ) / (grid.maxZ - grid.minZ);
  const ix = Math.min(grid.cellsX - 1, Math.max(0, Math.floor(fx * grid.cellsX)));
  const iz = Math.min(grid.cellsZ - 1, Math.max(0, Math.floor(fz * grid.cellsZ)));
  return iz * grid.cellsX + ix;
}


/**
 * True when the geometry is a CLOSED 2-manifold with CONSISTENT winding
 * whose triangles face OUTWARD (positive signed volume): its back faces are
 * then never visible from outside, so FrontSide rendering is exact.
 * Positions are welded at `weldEpsilon` (glTF splits vertices on UV / normal
 * seams). Every directed edge must appear exactly once and its reverse
 * exactly once — this rejects holes, T-junctions, non-manifold edges and
 * flipped triangles in one pass. Conservative: any doubt → false.
 */
export function isClosedOutward(geometry: THREE.BufferGeometry, weldEpsilon = 1e-3): boolean {
  const pos = geometry.getAttribute("position");
  const index = geometry.index;
  const n = index ? index.count : pos.count;
  if (n < 12) return false; // a closed solid needs at least 4 triangles

  const ids = weldPositions(pos, 1 / weldEpsilon);
  let count = 0;
  for (let v = 0; v < ids.length; v++) if (ids[v] >= count) count = ids[v] + 1;

  const directed = new Set<number>();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let volume6 = 0;
  for (let i = 0; i < n; i += 3) {
    const va = index ? index.getX(i) : i;
    const vb = index ? index.getX(i + 1) : i + 1;
    const vc = index ? index.getX(i + 2) : i + 2;
    const ia = ids[va];
    const ib = ids[vb];
    const ic = ids[vc];
    if (ia === ib || ib === ic || ia === ic) return false; // degenerate
    for (const key of [ia * count + ib, ib * count + ic, ic * count + ia]) {
      if (directed.has(key)) return false; // non-manifold or inconsistent winding
      directed.add(key);
    }
    a.fromBufferAttribute(pos, va);
    b.fromBufferAttribute(pos, vb);
    c.fromBufferAttribute(pos, vc);
    volume6 += a.dot(b.cross(c)); // 6 × signed volume of (origin, A, B, C)
  }
  for (const key of directed) {
    const u = Math.floor(key / count);
    const v = key - u * count;
    if (!directed.has(v * count + u)) return false; // open edge
  }
  return volume6 > 0;
}

/**
 * Weld ids of the positions (same rounded grid key as a `${x}_${y}_${z}`
 * string map, ids in order of first appearance) — PERF: an open-addressing
 * table on the three rounded integers instead of one string per vertex.
 */
function weldPositions(pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, inv: number): Int32Array {
  const n = pos.count;
  const ids = new Int32Array(n);
  let cap = 16;
  while (cap < n * 2) cap <<= 1;
  const mask = cap - 1;
  const slotId = new Int32Array(cap).fill(-1);
  const keys = new Float64Array(n * 3); // rounded grid coordinates per id
  let next = 0;
  for (let v = 0; v < n; v++) {
    const kx = Math.round(pos.getX(v) * inv);
    const ky = Math.round(pos.getY(v) * inv);
    const kz = Math.round(pos.getZ(v) * inv);
    let h = (Math.imul(kx | 0, 0x9e3779b1) ^ Math.imul(ky | 0, 0x85ebca77) ^ Math.imul(kz | 0, 0xc2b2ae3d)) & mask;
    for (;;) {
      const id = slotId[h];
      if (id < 0) {
        slotId[h] = next;
        keys[next * 3] = kx;
        keys[next * 3 + 1] = ky;
        keys[next * 3 + 2] = kz;
        ids[v] = next++;
        break;
      }
      if (same(keys[id * 3], kx) && same(keys[id * 3 + 1], ky) && same(keys[id * 3 + 2], kz)) {
        ids[v] = id;
        break;
      }
      h = (h + 1) & mask;
    }
  }
  return ids;
}

/** Equal rounded coordinates, as their strings would be (NaN === NaN, −0 = 0). */
function same(a: number, b: number): boolean {
  return a === b || (a !== a && b !== b);
}

type TypedArrayCtor = new (length: number) => THREE.TypedArray;

/**
 * Splits a geometry into one compact geometry per grid cell (triangle
 * centroid → cell). Every attribute is copied verbatim (raw array values:
 * normalized / integer attributes stay exact). Returns the INPUT geometry
 * alone (cell −1) when every triangle falls in a single cell.
 */
export function splitByGrid(
  geometry: THREE.BufferGeometry,
  grid: ChunkGrid,
): { geometry: THREE.BufferGeometry; cell: number }[] {
  const pos = geometry.getAttribute("position");
  const index = geometry.index;
  const tris = triangleCount(geometry);
  const vertexOf = (t: number, k: number): number => (index ? index.getX(t * 3 + k) : t * 3 + k);

  const cells = new Int32Array(tris);
  const counts = new Int32Array(grid.cellsX * grid.cellsZ);
  let used = 0;
  for (let t = 0; t < tris; t++) {
    let x = 0;
    let z = 0;
    for (let k = 0; k < 3; k++) {
      const v = vertexOf(t, k);
      x += pos.getX(v);
      z += pos.getZ(v);
    }
    const cell = cellOf(grid, x / 3, z / 3);
    cells[t] = cell;
    if (counts[cell]++ === 0) used++;
  }
  if (used <= 1) return [{ geometry, cell: -1 }];

  // mergeGeometries outputs plain attributes; anything else is rejected.
  const sources: [string, THREE.BufferAttribute][] = [];
  for (const name of Object.keys(geometry.attributes)) {
    const attr = geometry.getAttribute(name);
    if (!(attr instanceof THREE.BufferAttribute)) return [{ geometry, cell: -1 }];
    sources.push([name, attr]);
  }

  // PERF: triangles bucketed by cell once (ascending cell, then triangle
  // order — the order the per-cell scans used to visit them), and each
  // vertex remapped / copied only for the cells that use it: the former
  // per-cell scans of every triangle and every vertex were O(cells × size).
  const start = new Int32Array(counts.length + 1);
  for (let c = 0; c < counts.length; c++) start[c + 1] = start[c] + counts[c];
  const order = new Int32Array(tris);
  const fill = start.slice(0, counts.length);
  for (let t = 0; t < tris; t++) order[fill[cells[t]]++] = t;

  const remap = new Int32Array(pos.count);
  const remapCell = new Int32Array(pos.count).fill(-1);
  const verts = new Int32Array(pos.count); // part vertex → source vertex
  const out: { geometry: THREE.BufferGeometry; cell: number }[] = [];
  for (let cell = 0; cell < counts.length; cell++) {
    const n = counts[cell];
    if (n === 0) continue;
    const indices = new Uint32Array(n * 3);
    let vertexCount = 0;
    let w = 0;
    for (let o = start[cell]; o < start[cell + 1]; o++) {
      const t = order[o];
      for (let k = 0; k < 3; k++) {
        const v = vertexOf(t, k);
        if (remapCell[v] !== cell) {
          remapCell[v] = cell;
          remap[v] = vertexCount;
          verts[vertexCount++] = v;
        }
        indices[w++] = remap[v];
      }
    }
    const part = new THREE.BufferGeometry();
    for (const [name, src] of sources) {
      const size = src.itemSize;
      const srcArray = src.array as THREE.TypedArray;
      const dst = new (srcArray.constructor as TypedArrayCtor)(vertexCount * size);
      for (let r = 0; r < vertexCount; r++) {
        const v = verts[r];
        for (let c = 0; c < size; c++) dst[r * size + c] = srcArray[v * size + c];
      }
      part.setAttribute(name, new THREE.BufferAttribute(dst, size, src.normalized));
    }
    part.setIndex(new THREE.BufferAttribute(vertexCount <= 65535 ? new Uint16Array(indices) : indices, 1));
    out.push({ geometry: part, cell });
  }
  return out;
}

/**
 * World-space copy of a mesh geometry keeping only the `keep` attributes:
 * EXACTLY `geometry.clone().applyMatrix4(matrix)` followed by deleting the
 * other attributes (same float operations, same order, same attribute
 * objects' settings) — PERF: without copying / transforming the attributes
 * thrown away, nor recomputing bounds nobody reads (the bounding box is
 * recomputed on demand, from the same positions). Returns null when the
 * geometry is not plain (morph targets, interleaved / normalized / non-float
 * position or normal): the caller then takes the generic path.
 */
export function worldSpaceCopy(
  geometry: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
  keep: ReadonlySet<string>,
): THREE.BufferGeometry | null {
  if (Object.keys(geometry.morphAttributes).length > 0) return null;
  const plainFloat3 = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined) =>
    !a ||
    (!(a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute &&
      !a.normalized &&
      a.itemSize === 3 &&
      (a as THREE.BufferAttribute).array instanceof Float32Array);
  const srcPos = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  const srcNormal = geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
  if (!plainFloat3(srcPos) || !plainFloat3(srcNormal)) return null;
  for (const name of Object.keys(geometry.attributes)) {
    if (keep.has(name) && (geometry.attributes[name] as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) return null;
  }

  const out = new THREE.BufferGeometry();
  out.name = geometry.name;
  if (geometry.index) out.setIndex(geometry.index.clone());
  for (const name of Object.keys(geometry.attributes)) {
    if (keep.has(name)) out.setAttribute(name, (geometry.attributes[name] as THREE.BufferAttribute).clone());
  }
  for (const g of geometry.groups) out.addGroup(g.start, g.count, g.materialIndex);
  out.drawRange.start = geometry.drawRange.start;
  out.drawRange.count = geometry.drawRange.count;
  out.userData = geometry.userData;

  const e = matrix.elements;
  const pos = out.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (pos) {
    // Vector3.applyMatrix4 (perspective divide included), stored as float32.
    const a = pos.array as Float32Array;
    for (let i = 0; i < a.length; i += 3) {
      const x = a[i];
      const y = a[i + 1];
      const z = a[i + 2];
      const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
      a[i] = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
      a[i + 1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
      a[i + 2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
    }
    pos.needsUpdate = true;
  }
  const normal = out.getAttribute("normal") as THREE.BufferAttribute | undefined;
  if (normal) {
    // Vector3.applyNormalMatrix: applyMatrix3(normal matrix), then normalize.
    const n = new THREE.Matrix3().getNormalMatrix(matrix).elements;
    const a = normal.array as Float32Array;
    for (let i = 0; i < a.length; i += 3) {
      const x0 = a[i];
      const y0 = a[i + 1];
      const z0 = a[i + 2];
      const x = n[0] * x0 + n[3] * y0 + n[6] * z0;
      const y = n[1] * x0 + n[4] * y0 + n[7] * z0;
      const z = n[2] * x0 + n[5] * y0 + n[8] * z0;
      const inv = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
      a[i] = x * inv;
      a[i + 1] = y * inv;
      a[i + 2] = z * inv;
    }
    normal.needsUpdate = true;
  }
  return out;
}

/** Smallest side of the geometry's bounding box (m). */
function minExtent(geometry: THREE.BufferGeometry): number {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const size = geometry.boundingBox!.getSize(new THREE.Vector3());
  return Math.min(size.x, size.y, size.z);
}

/** May this source mesh be drawn single-sided? (see isClosedOutward) */
export function canBeSingleSided(
  entry: StaticEntry,
  maxThickness: number,
  keepMaterials: ReadonlySet<string>,
): boolean {
  const m = entry.material;
  if (maxThickness <= 0) return false;
  if (m.side !== THREE.DoubleSide || m.transparent || keepMaterials.has(m.name)) return false;
  if (minExtent(entry.geometry) > maxThickness) return false; // could contain the camera
  return isClosedOutward(entry.geometry);
}

/**
 * Builds the static draw batches: entries grouped by (material, side),
 * merged, then split on the grid when large enough. The FrontSide variant of
 * a material is a CLONE (same name, same textures / colours — only `side`
 * differs; ONE clone per material). Input geometries are NOT disposed.
 */
export function buildStaticBatches(
  entries: readonly StaticEntry[],
  merge: (geometries: THREE.BufferGeometry[]) => THREE.BufferGeometry | null,
  options: StaticBatchOptions,
): StaticBatch[] {
  const keep = options.keepMaterials ?? new Set<string>();
  const groups = new Map<THREE.Material, { singleSided: boolean; geometries: THREE.BufferGeometry[] }>();
  const frontClones = new Map<THREE.Material, THREE.Material>();
  for (const entry of entries) {
    const single = canBeSingleSided(entry, options.singleSidedMaxThickness, keep);
    let material = entry.material;
    if (single) {
      let clone = frontClones.get(material);
      if (!clone) {
        clone = material.clone();
        clone.name = material.name;
        clone.side = THREE.FrontSide;
        // Shadow caster: the faces turned toward the sun are the nearest to
        // the light on a closed solid → FrontSide writes exactly the depth
        // DoubleSide wrote (three's default would cast with BackSide here).
        clone.shadowSide = THREE.FrontSide;
        frontClones.set(material, clone);
      }
      material = clone;
    }
    const group = groups.get(material) ?? { singleSided: single, geometries: [] };
    group.geometries.push(entry.geometry);
    groups.set(material, group);
  }

  const out: StaticBatch[] = [];
  for (const [material, { singleSided, geometries }] of groups) {
    const merged = merge(geometries);
    if (!merged) throw new Error(`GivreRenderOptim: merge failed for material ${material.name}`);
    const parts =
      triangleCount(merged) >= options.chunkMinTriangles
        ? splitByGrid(merged, options.grid)
        : [{ geometry: merged, cell: -1 }];
    if (parts.length > 1) merged.dispose();
    for (const part of parts) out.push({ geometry: part.geometry, material, cell: part.cell, singleSided });
  }
  return out;
}

/**
 * MeshPhysicalMaterial → MeshStandardMaterial with the SAME colours,
 * textures (baked emissive + ao), roughness, side, transparency and name.
 * GLTFLoader only creates Physical materials in givre_01.glb for
 * KHR_materials_specular (no clearcoat / sheen / transmission / iridescence):
 * the only visible change is the specular level (Standard = fixed 4 % F0,
 * a faint highlight on matte surfaces). Other materials are returned as-is.
 */
export function toStandardMaterial(material: THREE.Material): THREE.Material {
  const physical = material as THREE.MeshPhysicalMaterial;
  if (!physical.isMeshPhysicalMaterial) return material;
  const standard = new THREE.MeshStandardMaterial();
  standard.copy(physical); // MeshStandardMaterial.copy resets defines to STANDARD
  standard.name = physical.name;
  standard.userData = { ...physical.userData };
  return standard;
}

/**
 * Limited mip chain for the baked lightmaps (givre_lumiere / givre_ao).
 * They used to have NO mipmap at all (a full mip chain makes the UV islands
 * of the atlas bleed into each other in the distance): every distant pixel
 * then sampled the 2048² level 0 → texture-cache thrashing, a real cost on
 * integrated GPUs. A SHORT chain (2048 → 1024 → 512 by default) keeps the
 * bleed within a few texels (well inside a usual bake margin) while
 * distant surfaces read a 4–16× smaller level.
 * Returns the levels (level 0 = the original image) or null when the image
 * cannot be downscaled here (Node, missing DOM, odd size) — the caller then
 * keeps the previous no-mipmap setup.
 */
export function buildLimitedMipmaps(image: unknown, levels: number): unknown[] | null {
  if (levels <= 1 || typeof document === "undefined") return null;
  const src = image as { width?: number; height?: number } | null;
  const w = src?.width ?? 0;
  const h = src?.height ?? 0;
  if (w < 2 || h < 2) return null;
  const out: unknown[] = [image];
  let prev = image as CanvasImageSource;
  let pw = w;
  let ph = h;
  for (let i = 1; i < levels && pw > 1 && ph > 1; i++) {
    const nw = Math.max(1, pw >> 1);
    const nh = Math.max(1, ph >> 1);
    const canvas = document.createElement("canvas");
    canvas.width = nw;
    canvas.height = nh;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(prev, 0, 0, pw, ph, 0, 0, nw, nh); // box-ish 2:1 downscale
    out.push(canvas);
    prev = canvas;
    pw = nw;
    ph = nh;
  }
  return out;
}

/**
 * Opaque sort for Givre: renderOrder first (stencil / outline contracts are
 * kept), then strictly FRONT-TO-BACK (early-Z rejects the rooms hidden
 * behind the walls), material only as a tie-break.
 */
export function frontToBackOpaqueSort(a: THREE.RenderItem, b: THREE.RenderItem): number {
  if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
  if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
  if (a.z !== b.z) return a.z - b.z;
  // Material.id exists at runtime (three's own painter sort uses it) but is
  // not declared by @types/three.
  const ma = (a.material as THREE.Material & { id: number }).id;
  const mb = (b.material as THREE.Material & { id: number }).id;
  if (ma !== mb) return ma - mb;
  return a.id - b.id;
}

/** A render item with its program rank cached for one sort (programFirstOpaqueSort). */
type RankedItem = THREE.RenderItem & { __programSort?: number; __programRank?: number };

/**
 * EXPERIMENT (`?diag=programsort`, off by default) — opaque sort for FEWER
 * STATE CHANGES: groupOrder and renderOrder first (the depth prepass's
 * proxies, stencil / outline contracts), then the PROGRAM three last drew
 * the material with, then the material, near → far inside a material,
 * object id last. Each program change re-sends the camera and light
 * uniforms, each material change the material's: grouped, they happen once
 * per program / material instead of at every alternation of the
 * front-to-back order.
 *
 * Meant for the map's depth prepass (GivreDepthPrepass, `?diag=prepass`):
 * once the map's depth is laid first, early-Z no longer needs the main pass
 * in front-to-back order. Without the prepass it trades GPU overdraw for CPU.
 *
 * Same image? Only where no two opaque fragments have EXACTLY the same
 * depth: with three's LEQUAL test the last one drawn wins a tie, and the
 * order changes (with or without the prepass, which keeps that rule) —
 * measured on the bench, never assumed (PERFORMANCE.md).
 *
 * The rank is read once per render item and per render() (three's frame
 * counter advances between the sort and the draws of each call): a
 * material not drawn yet (no program) goes after its group's programs.
 * A pass of `world` with an override material (the outline's normal
 * pre-pass: one material for all) keeps the front-to-back order.
 */
export function programFirstOpaqueSort(
  renderer: THREE.WebGLRenderer,
  world: THREE.Scene | null = null,
): (a: THREE.RenderItem, b: THREE.RenderItem) => number {
  const properties = renderer.properties;
  const render = renderer.info.render;
  const rank = (item: RankedItem): number => {
    const sort = render.frame;
    if (item.__programSort === sort) return item.__programRank!;
    const program = (properties.get(item.material) as { currentProgram?: { id: number } }).currentProgram;
    const r = program ? program.id : Number.MAX_SAFE_INTEGER;
    item.__programSort = sort;
    item.__programRank = r;
    return r;
  };
  return (a, b) => {
    if (world !== null && world.overrideMaterial !== null) return frontToBackOpaqueSort(a, b);
    if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
    if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
    const pa = rank(a), pb = rank(b);
    if (pa !== pb) return pa < pb ? -1 : 1;
    const ma = (a.material as THREE.Material & { id: number }).id;
    const mb = (b.material as THREE.Material & { id: number }).id;
    if (ma !== mb) return ma - mb;
    if (a.z !== b.z) return a.z - b.z;
    return a.id - b.id;
  };
}

